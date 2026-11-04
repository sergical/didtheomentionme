FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# yt-dlp needs a JS runtime to solve YouTube's player challenges.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN pip install --no-cache-dir "yt-dlp[default]"
WORKDIR /app
COPY server.py .
EXPOSE 8080
CMD ["python", "-u", "server.py"]
