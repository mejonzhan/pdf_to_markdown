import { build, context } from 'esbuild'
import { mkdir, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')
const srcDir = path.join(projectRoot, 'src')
const outDir = path.join(projectRoot, 'dist')

const watch = process.argv.includes('--watch')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await cp(path.join(srcDir, 'manifest.json'), path.join(outDir, 'manifest.json'))
await cp(path.join(srcDir, 'popup.html'), path.join(outDir, 'popup.html'))
await cp(path.join(srcDir, 'convert.html'), path.join(outDir, 'convert.html'))
await cp(path.join(srcDir, 'styles.css'), path.join(outDir, 'styles.css'))

const nodeModulesDir = path.join(projectRoot, 'node_modules')

const workerCandidates = [
  path.join(nodeModulesDir, 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
  path.join(nodeModulesDir, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  path.join(nodeModulesDir, 'pdfjs-dist', 'build', 'pdf.worker.mjs')
]

let workerSrc = null
for (const p of workerCandidates) {
  try {
    await cp(p, path.join(outDir, 'pdf.worker.mjs'))
    workerSrc = 'pdf.worker.mjs'
    break
  } catch {}
}

if (!workerSrc) {
  throw new Error('Cannot find pdfjs worker entry in pdfjs-dist.')
}

const buildOptions = {
  entryPoints: {
    popup: path.join(srcDir, 'popup.ts'),
    convert: path.join(srcDir, 'convert.ts')
  },
  outdir: outDir,
  bundle: true,
  format: 'esm',
  target: ['chrome114'],
  sourcemap: true,
  define: {
    __PDFJS_WORKER_PATH__: JSON.stringify(workerSrc)
  },
  logLevel: 'info'
}

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('[watch] ok')
} else {
  await build(buildOptions)
}
