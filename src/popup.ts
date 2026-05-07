const openConverterButton = document.getElementById('openConverter')

function getBaseDirFromPopupPath() {
  const popupPath = chrome.runtime.getManifest().action?.default_popup ?? ''
  const parts = popupPath.split('/').filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

if (openConverterButton) {
  openConverterButton.addEventListener('click', async () => {
    const baseDir = getBaseDirFromPopupPath()
    const convertPath = baseDir ? `${baseDir}/convert.html` : 'convert.html'
    const url = chrome.runtime.getURL(convertPath)
    await chrome.tabs.create({ url })
    window.close()
  })
}
