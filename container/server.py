import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPLOAD_THREADS = 16
UPLOAD_ATTEMPTS = 5
NOT_READY_STATES = {"is_live", "is_upcoming", "post_live"}
ID_PATTERN = re.compile(r"^[\w-]{1,64}$")
# Equal to JOB_PROTOCOL in src/container.ts. Bump both with each change to the /jobs contract.
JOB_PROTOCOL = 2
VIDEO_FORMAT = "bv*[height<=720][vcodec^=avc1]/bv*[height<=720]/b[height<=720]"
AUDIO_SEGMENT_SECONDS = 600

LOCK = threading.Lock()
JOBS = {}


class JobError(Exception):
    pass


def run(cmd, timeout=3600):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def run_checked(cmd, error_prefix, timeout=3600):
    code, stdout, stderr = run(cmd, timeout)
    if code != 0:
        raise JobError(f"{error_prefix} (exit {code}): {stderr.strip()[-1500:]}")
    return stdout


# ---------- /list ----------

def iso_from_timestamp(timestamp):
    if not timestamp:
        return None
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def list_tab(channel_id, tab, limit):
    url = f"https://www.youtube.com/channel/{channel_id}/{tab}"
    code, stdout, stderr = run([
        "yt-dlp", "--flat-playlist", "-J",
        "--extractor-args", "youtubetab:approximate_date",
        "-I", f"1:{limit}", url,
    ], timeout=300)
    if code != 0:
        # A channel without this tab is normal (many have no streams).
        if "does not have a" in stderr or "HTTP Error 404" in stderr:
            return []
        raise RuntimeError(stderr.strip()[-1500:])
    return json.loads(stdout).get("entries") or []


def list_videos(channel_id, limit):
    videos, seen = [], set()
    for tab in ("videos", "streams"):
        for entry in list_tab(channel_id, tab, limit):
            if not entry or not entry.get("id") or entry["id"] in seen:
                continue
            seen.add(entry["id"])
            videos.append({
                "id": entry["id"],
                "title": entry.get("title"),
                "publishedAt": iso_from_timestamp(entry.get("timestamp")),
                "duration": entry.get("duration"),
                "liveStatus": entry.get("live_status"),
            })
    return videos


# ---------- VTT ----------

def parse_vtt(text):
    """YouTube auto-caption VTT to [(seconds, word)] using the inline word timings."""
    words, seen = [], set()
    cue_start = None
    for line in text.splitlines():
        m = re.match(r"(\d+):(\d+):([\d.]+) -->", line)
        if m:
            cue_start = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
            continue
        if "<c>" not in line:
            continue
        t = cue_start
        for i, chunk in enumerate(re.split(r"<(\d+:\d+:[\d.]+)>", line.strip())):
            if i % 2 == 1:
                h, mi, s = chunk.split(":")
                t = int(h) * 3600 + int(mi) * 60 + float(s)
                continue
            for w in re.sub(r"</?c>", "", chunk).split():
                key = (round(t, 2), w)
                if key not in seen:
                    seen.add(key)
                    words.append((t, w))
    return words


# ---------- jobs ----------

def update_job(video_id, **fields):
    with LOCK:
        JOBS[video_id].update(fields)


def job_status(video_id):
    with LOCK:
        job = JOBS.get(video_id)
        if job is None:
            return None
        return {k: job[k] for k in ("state", "stage", "uploaded", "total", "error", "manifest")}


class Uploader:
    def __init__(self, video_id, upload_base, token):
        self.video_id = video_id
        self.base = upload_base.rstrip("/")
        self.token = token
        self.pool = ThreadPoolExecutor(max_workers=UPLOAD_THREADS)
        self.futures = []

    def submit(self, key, content_type, data=None, path=None):
        with LOCK:
            JOBS[self.video_id]["total"] += 1
        self.futures.append(self.pool.submit(self._put, key, content_type, data, path))

    def _put(self, key, content_type, data, path):
        body = data if path is None else path.read_bytes()
        last_error = None
        for attempt in range(UPLOAD_ATTEMPTS):
            try:
                req = urllib.request.Request(
                    f"{self.base}/internal/r2/{key}",
                    data=body,
                    method="PUT",
                    headers={"authorization": f"Bearer {self.token}", "content-type": content_type},
                )
                with urllib.request.urlopen(req, timeout=120) as res:
                    res.read()
                with LOCK:
                    JOBS[self.video_id]["uploaded"] += 1
                return
            except Exception as e:
                last_error = e
                if attempt < UPLOAD_ATTEMPTS - 1:
                    time.sleep(2 ** attempt)
        raise JobError(f"upload {key} failed: {last_error}")

    def wait(self):
        errors = [e for e in (f.exception() for f in self.futures) if e]
        if errors:
            raise errors[0]

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)


def fetch_metadata(video_id):
    code, stdout, stderr = run(
        ["yt-dlp", "-J", "--no-playlist", f"https://www.youtube.com/watch?v={video_id}"], timeout=300,
    )
    if code != 0:
        # yt-dlp fails outright for scheduled streams and premieres instead of reporting live_status.
        if "live event will begin" in stderr or "Premieres in" in stderr:
            raise JobError("not_ready")
        raise JobError(f"metadata failed (exit {code}): {stderr.strip()[-1500:]}")
    info = json.loads(stdout)
    if info.get("live_status") in NOT_READY_STATES:
        raise JobError("not_ready")
    published = iso_from_timestamp(info.get("timestamp"))
    if not published and info.get("upload_date"):
        d = info["upload_date"]
        published = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    return {"title": info.get("title"), "duration": info.get("duration"), "publishedAt": published}


def extract_words(video_id, tmp):
    """Download English auto-captions and parse them. Returns (words, why there are none)."""
    code, _, stderr = run([
        "yt-dlp", "--skip-download", "--write-auto-subs", "--sub-langs", "en", "--sub-format", "vtt",
        "--no-playlist", "-o", str(tmp / "subs.%(ext)s"), f"https://www.youtube.com/watch?v={video_id}",
    ], timeout=300)
    for vtt in tmp.glob("subs*.vtt"):
        words = parse_vtt(vtt.read_text(encoding="utf-8"))
        if words:
            return words, None
    if code != 0:
        return [], f"yt-dlp exit {code}: {stderr.strip()[-500:]}"
    return [], "no English auto-captions"


def extract_audio_chunks(video_id, tmp, uploader):
    source_template = str(tmp / "audio_src.%(ext)s")
    run_checked(
        ["yt-dlp", "-f", "bestaudio", "--no-playlist", "-o", source_template,
         f"https://www.youtube.com/watch?v={video_id}"],
        "audio download failed",
    )
    source = next(tmp.glob("audio_src.*"))
    out_dir = tmp / "audio"
    out_dir.mkdir()
    run_checked(
        ["ffmpeg", "-v", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "libmp3lame", "-f", "segment", "-segment_time", str(AUDIO_SEGMENT_SECONDS),
         "-reset_timestamps", "1", str(out_dir / "%03d.mp3")],
        "audio convert failed",
    )
    source.unlink()
    chunks = sorted(out_dir.glob("*.mp3"))
    for chunk in chunks:
        uploader.submit(f"videos/{video_id}/audio/{chunk.name}", "audio/mpeg", path=chunk)
    return len(chunks)


def extract_frames(video_id, tmp, uploader):
    run_checked(
        ["yt-dlp", "-f", VIDEO_FORMAT, "--no-playlist", "-o", str(tmp / "video.%(ext)s"),
         f"https://www.youtube.com/watch?v={video_id}"],
        "video download failed",
    )
    video = next(p for p in tmp.glob("video.*") if p.suffix != ".part")
    update_job(video_id, stage="frames")
    for name in ("f640", "f1280"):
        (tmp / name).mkdir()
    # fps gives a 1/1 time base, so frame_pts names each image by its second, from 0.
    run_checked(
        ["ffmpeg", "-v", "error", "-i", str(video), "-an",
         "-filter_complex", "[0:v]fps=1,split=2[a][b];[a]scale=640:-2[s640];[b]scale=1280:-2[s1280]",
         "-map", "[s640]", "-q:v", "5", "-fps_mode", "vfr", "-enc_time_base", "1:1", "-frame_pts", "1", str(tmp / "f640" / "%d.jpg"),
         "-map", "[s1280]", "-q:v", "4", "-fps_mode", "vfr", "-enc_time_base", "1:1", "-frame_pts", "1", str(tmp / "f1280" / "%d.jpg")],
        "ffmpeg failed",
    )
    video.unlink()
    frames = sorted((int(p.stem) for p in (tmp / "f640").glob("*.jpg")))
    for second in frames:
        for name in ("f640", "f1280"):
            path = tmp / name / f"{second}.jpg"
            if path.exists():
                uploader.submit(f"videos/{video_id}/{name}/{second}.jpg", "image/jpeg", path=path)
    return len(frames), frames


def notify(upload_base, token, instance_id, status):
    """Sends the final job status to the workflow. If every attempt fails, the workflow checks the job itself."""
    body = json.dumps(status).encode()
    for attempt in range(UPLOAD_ATTEMPTS):
        try:
            req = urllib.request.Request(
                f"{upload_base.rstrip('/')}/internal/events/{instance_id}",
                data=body,
                method="POST",
                headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=60) as res:
                res.read()
            return
        except Exception as e:
            if attempt < UPLOAD_ATTEMPTS - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"notify {instance_id} failed: {e}", file=sys.stderr, flush=True)


def process_job(video_id, upload_base, token, instance_id):
    tmp = Path(tempfile.mkdtemp(prefix=f"job-{video_id}-"))
    uploader = Uploader(video_id, upload_base, token)
    try:
        update_job(video_id, stage="metadata")
        meta = fetch_metadata(video_id)

        update_job(video_id, stage="captions")
        words, captions_error = extract_words(video_id, tmp)
        audio_chunks = 0
        if words:
            payload = json.dumps([[round(t, 2), w] for t, w in words], separators=(",", ":"))
            uploader.submit(f"videos/{video_id}/words.json", "application/json", data=payload.encode())
        else:
            update_job(video_id, stage="audio")
            audio_chunks = extract_audio_chunks(video_id, tmp, uploader)

        update_job(video_id, stage="download")
        frames, kept_seconds = extract_frames(video_id, tmp, uploader)

        update_job(video_id, stage="upload")
        uploader.wait()
        manifest = {
            "videoId": video_id,
            "title": meta["title"],
            "duration": meta["duration"],
            "publishedAt": meta["publishedAt"],
            "frames": frames,
            "keptSeconds": kept_seconds,
            "hasCaptions": bool(words),
            "captionsError": captions_error,
            "audioChunks": audio_chunks,
        }
        uploader.submit(f"videos/{video_id}/manifest.json", "application/json", data=json.dumps(manifest).encode())
        uploader.wait()
        update_job(video_id, state="done", stage="done", manifest=manifest)
    except Exception as e:
        update_job(video_id, state="error", error=str(e) if isinstance(e, JobError) else f"{type(e).__name__}: {e}")
    finally:
        uploader.close()
        shutil.rmtree(tmp, ignore_errors=True)
    if instance_id:
        notify(upload_base, token, instance_id, job_status(video_id))


def start_job(video_id, upload_base, token, instance_id):
    """Returns the job status; starts a thread unless a job is running or done."""
    with LOCK:
        job = JOBS.get(video_id)
        if job is None or job["state"] == "error":
            JOBS[video_id] = {
                "state": "running", "stage": "metadata", "uploaded": 0, "total": 0,
                "error": None, "manifest": None,
            }
            threading.Thread(target=process_job, args=(video_id, upload_base, token, instance_id), daemon=True).start()
    return job_status(video_id)


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/":
            _, stdout, _ = run(["yt-dlp", "--version"], timeout=30)
            self.send_json(200, {"ytdlp": stdout.strip()})
        elif self.path == "/busy":
            with LOCK:
                busy = any(job["state"] == "running" for job in JOBS.values())
            self.send_json(200, {"busy": busy})
        elif self.path.startswith("/jobs/"):
            status = job_status(self.path[len("/jobs/"):])
            if status is None:
                self.send_json(404, {"error": "unknown job"})
            else:
                self.send_json(200, status)
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json(400, {"error": "invalid json"})
        if self.path == "/list":
            channel_id = str(body.get("channelId", ""))
            if not ID_PATTERN.match(channel_id):
                return self.send_json(400, {"error": "invalid channelId"})
            try:
                limit = int(body.get("limit", 80))
                self.send_json(200, {"videos": list_videos(channel_id, limit)})
            except Exception as e:
                self.send_json(502, {"error": str(e)})
        elif self.path == "/jobs":
            video_id, upload_base, token, instance_id = (
                str(body.get(k, "")) for k in ("videoId", "uploadBase", "token", "instanceId")
            )
            if not ID_PATTERN.match(video_id) or not upload_base or not token:
                return self.send_json(400, {"error": "videoId, uploadBase and token are required"})
            if instance_id and not ID_PATTERN.match(instance_id):
                return self.send_json(400, {"error": "invalid instanceId"})
            self.send_json(202, {**start_job(video_id, upload_base, token, instance_id), "protocol": JOB_PROTOCOL})
        else:
            self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    import os

    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
