/** An uploaded image as a small `data:` URL: scaled to fit 128px and written as
    PNG, so a logo is a few KB whatever was picked and needs no file store — it
    is stored on the row like a pasted URL is. */
export async function logoFromFile(file: File, size = 128): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not an image.")
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL("image/png")
}
