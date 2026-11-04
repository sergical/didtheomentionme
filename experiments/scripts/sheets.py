# Builds 4x4 contact sheets from 1 fps frames, one tile every STEP seconds, labelled with the timestamp.
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

frames_dir, out_dir, step = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
frames = sorted(frames_dir.glob("*.jpg"))[::step]
tile_w, tile_h, cols = 480, 270, 4
font = ImageFont.load_default(size=24)
out_dir.mkdir(exist_ok=True)
for sheet_idx in range(0, len(frames), cols * cols):
    sheet = Image.new("RGB", (tile_w * cols, tile_h * cols))
    for i, path in enumerate(frames[sheet_idx : sheet_idx + cols * cols]):
        seconds = int(path.stem) - 1
        tile = Image.open(path).resize((tile_w, tile_h))
        draw = ImageDraw.Draw(tile)
        label = f"{seconds // 60}:{seconds % 60:02d}"
        draw.rectangle((0, 0, 86, 30), fill="black")
        draw.text((6, 2), label, fill="yellow", font=font)
        sheet.paste(tile, ((i % cols) * tile_w, (i // cols) * tile_h))
    sheet.save(out_dir / f"{sheet_idx // (cols * cols):03d}.jpg", quality=80)
