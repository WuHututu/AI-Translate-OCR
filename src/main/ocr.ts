import type { CapturedImage, OcrResult } from "../shared/types";

type TesseractWorker = {
  recognize: (image: Buffer) => Promise<{ data?: { text?: string } }>;
  terminate: () => Promise<unknown>;
};

let worker: TesseractWorker | null = null;
let workerLanguages = "";

export async function recognizeImages(images: CapturedImage[], languages: string): Promise<OcrResult> {
  const started = Date.now();
  const cleanLanguages = languages.trim() || "eng+chi_sim";

  if (!images.length) {
    return {
      text: "",
      latencyMs: 0
    };
  }

  const activeWorker = await getWorker(cleanLanguages);
  const textParts: string[] = [];

  for (const image of images) {
    const result = await activeWorker.recognize(image.png);
    const text = result.data?.text?.trim();
    if (text) {
      textParts.push(text);
    }
  }

  return {
    text: textParts.join("\n\n"),
    latencyMs: Date.now() - started
  };
}

export async function shutdownOcr(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    workerLanguages = "";
  }
}

async function getWorker(languages: string): Promise<TesseractWorker> {
  if (worker && workerLanguages === languages) {
    return worker;
  }

  if (worker) {
    await worker.terminate();
  }

  const tesseract = (await import("tesseract.js")) as unknown as {
    createWorker: (languages: string) => Promise<TesseractWorker>;
  };

  worker = await tesseract.createWorker(languages);
  workerLanguages = languages;
  return worker;
}

