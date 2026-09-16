import { PDFDocument } from 'pdf-lib'

// One page per image, each sized to that image - replaces the external
// image-to-pdf service call with an in-process conversion (no extra
// network hop or separate deployment to maintain).
export async function imagesToPdf(images) {
  const pdfDoc = await PDFDocument.create()
  for (const { buffer, mimetype } of images) {
    const image =
      mimetype === 'image/png' ? await pdfDoc.embedPng(buffer) : await pdfDoc.embedJpg(buffer)
    const page = pdfDoc.addPage([image.width, image.height])
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  }
  return Buffer.from(await pdfDoc.save())
}
