import { createWorker } from 'tesseract.js'
import pdfParse from 'pdf-parse'
import { PDFDocument } from 'pdf-lib'

const TESSDATA_DIR = process.env.TESSDATA_DIR || '/app/tessdata'
const OCR_LANG = process.env.OCR_LANG || 'por'

let workerPromise

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(OCR_LANG, 1, {
      langPath: TESSDATA_DIR,
      cachePath: TESSDATA_DIR,
    })
  }
  return workerPromise
}

// Returns extracted text, or null if nothing usable could be extracted
// (e.g. a scanned PDF with no text layer - not supported yet).
export async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    const data = await pdfParse(buffer)
    const text = (data.text || '').trim()
    return text.length > 20 ? text : null
  }

  if (mimetype.startsWith('image/')) {
    const worker = await getWorker()
    const { data } = await worker.recognize(buffer)
    const text = (data.text || '').trim()
    return text.length > 0 ? text : null
  }

  return null
}

// Wraps a single image in its own PDF page, sized to the image - not a
// scan-to-searchable-PDF conversion, just packaging the image as PDF.
export async function imageToPdf(buffer, mimetype) {
  const pdfDoc = await PDFDocument.create()
  const image =
    mimetype === 'image/png' ? await pdfDoc.embedPng(buffer) : await pdfDoc.embedJpg(buffer)
  const page = pdfDoc.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  return Buffer.from(await pdfDoc.save())
}
