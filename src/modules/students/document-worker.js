import { extractionResult } from "./text-extraction.js";
// Deliberate limits are reported by code so the student sees the real reason.
const limit = (code) => Object.assign(new Error(code), { limit: code });
process.once("message", async (workerData) => {
try {
  const buffer = Buffer.from(workerData.data);
  const name = workerData.filename.toLowerCase();
  let text,
    pageCount = null;
  if (name.endsWith(".pdf")) {
    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw Error("Invalid PDF");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      if (info.total > 100) throw limit("TOO_MANY_PAGES");
      pageCount = info.total;
      // No "-- n of m --" page markers in stored text.
      text = (await parser.getText({ pageJoiner: "" })).text;
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
          throw limit("DOCUMENT_TOO_LARGE");
      }
    const mammoth = await import("mammoth");
    text = (
      await mammoth.extractRawText({ buffer }, { externalFileAccess: false })
    ).value;
  } else text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  process.send({ type: "document:result", result: extractionResult(text, pageCount) }, () => process.disconnect());
} catch (error) {
  process.send({ type: "document:result", result: { error: error?.limit || "UNREADABLE" } }, () => process.disconnect());
}
});
