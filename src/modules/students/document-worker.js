import { parentPort, workerData } from "node:worker_threads";
try {
  const buffer = Buffer.from(workerData.data);
  const name = workerData.filename.toLowerCase();
  let text;
  if (name.endsWith(".pdf")) {
    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw Error("Invalid PDF");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      if (info.total > 100) throw Error("Too many pages");
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (name.endsWith(".docx")) {
    // Inspect ZIP directory sizes before decompression to bound compressed input.
    let total = 0,
      entries = 0;
    for (let i = 0; i < buffer.length - 46; i++)
      if (buffer.readUInt32LE(i) === 0x02014b50) {
        total += buffer.readUInt32LE(i + 24);
        entries++;
        if (total > 20 * 1024 * 1024 || entries > 1000)
          throw Error("Expanded document is too large");
      }
    const mammoth = await import("mammoth");
    text = (
      await mammoth.extractRawText({ buffer }, { externalFileAccess: false })
    ).value;
  } else text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  parentPort.postMessage({
    text: text.replaceAll("\u0000", "").slice(0, 80000),
  });
} catch {
  parentPort.postMessage({ error: "Unable to extract text" });
}
