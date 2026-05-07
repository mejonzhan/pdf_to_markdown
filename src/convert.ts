import JSZip from 'jszip'
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).toString()

type ConvertResult = {
  markdown: string
  zipBlob: Blob
  mdBlob: Blob
  suggestedBaseName: string
}

const fileInput = document.getElementById('fileInput') as HTMLInputElement | null
const includeImages = document.getElementById('includeImages') as HTMLInputElement | null
const statusEl = document.getElementById('status')
const progressEl = document.getElementById('progress')
const mdPreview = document.getElementById('mdPreview') as HTMLTextAreaElement | null
const downloadZipBtn = document.getElementById('downloadZip') as HTMLButtonElement | null
const downloadMdBtn = document.getElementById('downloadMd') as HTMLButtonElement | null

let lastResult: ConvertResult | null = null
let converting = false

function setStatus(text: string, isError = false) {
  if (statusEl) {
    statusEl.textContent = text
    statusEl.style.color = isError ? 'var(--danger)' : 'var(--text)'
  }
}

function setProgress(text: string) {
  if (progressEl) progressEl.textContent = text
}

function setButtonsEnabled(enabled: boolean) {
  if (downloadZipBtn) downloadZipBtn.disabled = !enabled
  if (downloadMdBtn) downloadMdBtn.disabled = !enabled
}

function sanitizeBaseName(name: string) {
  const withoutExt = name.replace(/\.pdf$/i, '')
  return withoutExt.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'output'
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  })
}

function toMarkdownHeader(title: string, level = 2) {
  return `${'#'.repeat(level)} ${title}\n\n`
}

function normalizeLine(line: string) {
  return line.replace(/\s+/g, ' ').trim()
}

function buildLinesFromTextItems(
  items: Array<{
    str: string
    transform: number[]
    width: number
    height: number
  }>
) {
  const cleaned = items
    .map((it) => {
      const x = it.transform[4]
      const y = it.transform[5]
      return { ...it, x, y }
    })
    .filter((it) => normalizeLine(it.str).length > 0)

  cleaned.sort((a, b) => {
    if (a.y !== b.y) return b.y - a.y
    return a.x - b.x
  })

  const lines: string[] = []
  let currentY: number | null = null
  let lineParts: string[] = []
  let lastXEnd = -Infinity
  const sameLineThreshold = 4

  const flush = () => {
    const line = normalizeLine(lineParts.join(''))
    if (line.length > 0) lines.push(line)
    lineParts = []
    lastXEnd = -Infinity
  }

  for (const it of cleaned) {
    if (currentY === null) currentY = it.y

    if (Math.abs(it.y - currentY) > sameLineThreshold) {
      flush()
      currentY = it.y
    }

    const gap = it.x - lastXEnd
    if (gap > 2 && lineParts.length > 0) lineParts.push(' ')
    lineParts.push(it.str)
    lastXEnd = it.x + it.width
  }

  flush()
  return lines
}

async function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed.'))), 'image/png')
  })
}

async function imageObjectToPngBlob(imageObj: any) {
  const bitmap = imageObj?.bitmap
  const width = Number(imageObj?.width ?? bitmap?.width)
  const height = Number(imageObj?.height ?? bitmap?.height)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Unsupported image object (missing size).')
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width)
  canvas.height = Math.ceil(height)

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Cannot init canvas context.')

  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0)
    return await canvasToPngBlob(canvas)
  }

  if (imageObj instanceof ImageBitmap) {
    ctx.drawImage(imageObj, 0, 0)
    return await canvasToPngBlob(canvas)
  }

  if (imageObj instanceof HTMLCanvasElement) {
    ctx.drawImage(imageObj, 0, 0)
    return await canvasToPngBlob(canvas)
  }

  if (imageObj instanceof HTMLImageElement) {
    ctx.drawImage(imageObj, 0, 0)
    return await canvasToPngBlob(canvas)
  }

  const raw = imageObj?.data
  if (raw && (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray)) {
    const data = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw)
    const imgData = new ImageData(data, canvas.width, canvas.height)
    ctx.putImageData(imgData, 0, 0)
    return await canvasToPngBlob(canvas)
  }

  throw new Error('Unsupported image object type.')
}

function waitForPdfObject(container: any, objId: string) {
  return new Promise<any>((resolve, reject) => {
    try {
      if (container?.has?.(objId)) return resolve(container.get(objId))
    } catch {}

    try {
      container?.get?.(objId, (data: any) => resolve(data))
    } catch (e) {
      reject(e)
    }
  })
}

async function getImageObjectFromPage(page: any, objId: string) {
  try {
    return await waitForPdfObject(page.objs, objId)
  } catch {}

  try {
    return await waitForPdfObject(page.commonObjs, objId)
  } catch {}

  return null
}

async function extractEmbeddedImagesFromPage(page: any) {
  const operatorList = await page.getOperatorList()
  const results: Blob[] = []
  const seenKeys = new Set<string>()

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i]
    const args = operatorList.argsArray[i] ?? []

    if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const objId = args?.[0]
      if (typeof objId !== 'string') continue
      const key = `xobj:${objId}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)

      const imgObj = await getImageObjectFromPage(page, objId)
      if (!imgObj) continue
      try {
        results.push(await imageObjectToPngBlob(imgObj))
      } catch {}
      continue
    }

    if (fn === OPS.paintInlineImageXObject) {
      const imgObj = args?.[0]
      const key = `inline:${i}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)

      if (!imgObj) continue
      try {
        results.push(await imageObjectToPngBlob(imgObj))
      } catch {}
    }
  }

  return results
}

async function convertPdf(file: File, withImages: boolean) {
  const baseName = sanitizeBaseName(file.name)
  const data = await file.arrayBuffer()

  const loadingTask = getDocument({ data })
  const pdf = await loadingTask.promise

  const zip = new JSZip()
  const imagesFolder = zip.folder('images')
  if (!imagesFolder) throw new Error('Cannot init zip folder.')

  let markdown = `# ${baseName}\n\n`

  for (let i = 1; i <= pdf.numPages; i++) {
    setProgress(`正在处理第 ${i}/${pdf.numPages} 页…`)
    const page = await pdf.getPage(i)

    const textContent = await page.getTextContent()
    const lines = buildLinesFromTextItems(textContent.items as any)

    markdown += toMarkdownHeader(`第 ${i} 页`)
    if (lines.length > 0) {
      markdown += `${lines.join('\n')}\n\n`
    } else {
      markdown += `（本页未检测到可提取文字）\n\n`
    }

    if (withImages) {
      const images = await extractEmbeddedImagesFromPage(page)
      for (let j = 0; j < images.length; j++) {
        const imgName = `page-${String(i).padStart(3, '0')}-img-${String(j + 1).padStart(2, '0')}.png`
        imagesFolder.file(imgName, images[j])
        markdown += `![第 ${i} 页图片 ${j + 1}](images/${imgName})\n\n`
      }
    }
  }

  zip.file('output.md', markdown)

  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const mdBlob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })

  return {
    markdown,
    zipBlob,
    mdBlob,
    suggestedBaseName: baseName
  } satisfies ConvertResult
}

async function runConvert(file: File) {
  if (converting) return
  converting = true
  lastResult = null
  setButtonsEnabled(false)
  setStatus('正在转换…')
  setProgress('')

  try {
    const withImages = includeImages?.checked ?? true
    const result = await convertPdf(file, withImages)
    lastResult = result
    if (mdPreview) mdPreview.value = result.markdown
    setStatus('转换完成。')
    setProgress(withImages ? '已生成 output.md 与 images/，并打包为 zip。' : '已生成 output.md。')
    setButtonsEnabled(true)
  } catch (e: any) {
    setStatus(`转换失败：${e?.message || String(e)}`, true)
    setProgress('')
    setButtonsEnabled(false)
  } finally {
    converting = false
  }
}

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  await runConvert(file)
})

includeImages?.addEventListener('change', async () => {
  const file = fileInput?.files?.[0]
  if (!file) return
  await runConvert(file)
})

downloadZipBtn?.addEventListener('click', async () => {
  if (!lastResult) return
  triggerDownload(lastResult.zipBlob, `${lastResult.suggestedBaseName}.zip`)
})

downloadMdBtn?.addEventListener('click', async () => {
  if (!lastResult) return
  triggerDownload(lastResult.mdBlob, `${lastResult.suggestedBaseName}.md`)
})
