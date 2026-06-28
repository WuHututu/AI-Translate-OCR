import { desktopCapturer, screen } from "electron";
import type { CapturedImage, Rect } from "../shared/types";

export function getVirtualBounds(): Rect {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

export async function captureSelection(selection: Rect): Promise<CapturedImage[]> {
  const displays = screen.getAllDisplays();
  const parts = displays
    .map((display, index) => ({
      display,
      index,
      rect: intersect(selection, display.bounds)
    }))
    .filter((part): part is { display: Electron.Display; index: number; rect: Rect } => Boolean(part.rect));

  if (!parts.length) {
    throw new Error("Selection is outside all displays");
  }

  const thumbnailSize = {
    width: Math.ceil(Math.max(...displays.map((display) => display.bounds.width * display.scaleFactor))),
    height: Math.ceil(Math.max(...displays.map((display) => display.bounds.height * display.scaleFactor)))
  };

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false
  });

  const images: CapturedImage[] = [];

  for (const part of parts) {
    const source = sources.find((candidate) => candidate.display_id === String(part.display.id)) ?? sources[part.index] ?? sources[0];

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Unable to capture the screen source");
    }

    const sourceSize = source.thumbnail.getSize();
    const scaleX = sourceSize.width / part.display.bounds.width;
    const scaleY = sourceSize.height / part.display.bounds.height;
    const cropRect = {
      x: Math.max(0, Math.round((part.rect.x - part.display.bounds.x) * scaleX)),
      y: Math.max(0, Math.round((part.rect.y - part.display.bounds.y) * scaleY)),
      width: Math.max(1, Math.round(part.rect.width * scaleX)),
      height: Math.max(1, Math.round(part.rect.height * scaleY))
    };

    const cropped = source.thumbnail.crop(cropRect);
    images.push({
      displayId: String(part.display.id),
      bounds: part.rect,
      dataUrl: cropped.toDataURL(),
      png: cropped.toPNG()
    });
  }

  return images.sort((a, b) => (a.bounds.y === b.bounds.y ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y));
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  if (x2 <= x1 || y2 <= y1) {
    return null;
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  };
}