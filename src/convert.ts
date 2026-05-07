import JSZip from 'jszip'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'

declare const __PDFJS_WORKER_PATH__: string

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(__PDFJS_WORKER_PATH__)

type ConvertResult = {
  markdown: string
  zipBlob: Blob
  mdBlob: Blob
  suggestedBaseName: string
}

const fileInput = document.getElementById('fileInput') as HTMLInputElement | null
const includePageImages = document.getElementById('includePageImages') as HTMLInputElement | null
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

async function renderPageToPngBlob(page: any) {
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Cannot init canvas context.')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)

  await page.render({ canvasContext: ctx, viewport }).promise

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed.'))), 'image/png')
  })
  return blob
}

async function convertPdf(file: File, withPageImages: boolean) {
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

    if (withPageImages) {
      const imgBlob = await renderPageToPngBlob(page)
      const imgName = `page-${String(i).padStart(3, '0')}.png`
      imagesFolder.file(imgName, imgBlob)
      markdown += `![第 ${i} 页](images/${imgName})\n\n`
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
    const withPageImages = includePageImages?.checked ?? true
    const result = await convertPdf(file, withPageImages)
    lastResult = result
    if (mdPreview) mdPreview.value = result.markdown
    setStatus('转换完成。')
    setProgress(withPageImages ? '已生成 output.md 与 images/，并打包为 zip。' : '已生成 output.md。')
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

includePageImages?.addEventListener('change', async () => {
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

