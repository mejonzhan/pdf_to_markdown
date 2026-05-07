// src/popup.ts
var openConverterButton = document.getElementById("openConverter");
if (openConverterButton) {
  openConverterButton.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("convert.html");
    await chrome.tabs.create({ url });
    window.close();
  });
}
//# sourceMappingURL=popup.js.map
