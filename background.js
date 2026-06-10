// Kibitz service worker (MV3). Two jobs:
//   1. Open the side panel when the toolbar icon is clicked. The panel is GLOBAL
//      (one per window), so its document — which hosts the call engine + WebRTC —
//      persists as you switch tabs and navigate. That's what lets a shared cast
//      survive page navigation.
//   2. Mint a chrome.tabCapture stream id for the active tab on request, so the
//      side panel can consume it (getUserMedia) and publish it into the room.

// Quiet by default; flip to true to see [kibitz-bg] logs in the service-worker console.
const DEBUG = false
const dbg = (...a) => {
  if (DEBUG) console.log(...a)
}

// Open the side panel when the toolbar icon is clicked — handled EXPLICITLY here,
// not via openPanelOnActionClick. Reason: the action click is also what grants the
// `activeTab` permission for the current page, and chrome.tabCapture refuses to
// capture a tab the extension was never "invoked" on. With openPanelOnActionClick
// the click is consumed by the panel-open and activeTab is NOT granted (capture
// fails with "Extension has not been invoked for the current page"). Handling
// onClicked ourselves means the click both grants activeTab AND opens the panel, so
// opening Kibitz on a page is exactly what unlocks sharing that page.
// IMPORTANT: openPanelOnActionClick persists in Chrome's per-extension settings, so
// a prior build that set it `true` keeps consuming the toolbar click (auto-opening
// the panel) and action.onClicked never fires — no activeTab grant. Force it OFF so
// our handler runs.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})

chrome.action.onClicked.addListener((tab) => {
  // Reaching here means the click counted as an invocation → activeTab is now granted
  // for `tab`, which is what chrome.tabCapture needs.
  dbg('[kibitz-bg] toolbar clicked → activeTab granted for tab', tab && tab.id, tab && tab.url)
  if (tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => dbg('[kibitz-bg] open panel:', e && e.message))
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'kibitz-capture-tab') {
    // The side panel asks us to capture whichever tab is currently active. We mint
    // a stream id for that tab; the panel consumes it. Capturing follows the tab as
    // it navigates, and the panel (which holds the stream) outlives the navigation.
    dbg('[kibitz-bg] capture-tab requested')
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0]
      dbg('[kibitz-bg] active tab:', tab && tab.id, tab && tab.url)
      if (!tab || tab.id == null) {
        sendResponse({ err: 'no active tab' })
        return
      }
      // Chrome refuses to tab-capture its own surfaces — say so clearly.
      const url = tab.url || ''
      if (/^(chrome|edge|about|chrome-extension|devtools):/.test(url) || /chrome\.google\.com\/webstore/.test(url)) {
        sendResponse({ err: 'this page can’t be shared (Chrome blocks its own pages) — switch to a website tab' })
        return
      }
      if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
        dbg('[kibitz-bg] chrome.tabCapture.getMediaStreamId UNAVAILABLE in the service worker')
        sendResponse({ err: 'tabCapture unavailable in background', noBg: true })
        return
      }
      try {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
          const err = chrome.runtime.lastError && chrome.runtime.lastError.message
          dbg('[kibitz-bg] getMediaStreamId →', streamId, 'err:', err)
          sendResponse({ streamId, tabId: tab.id, title: tab.title || '', url, err })
        })
      } catch (e) {
        dbg('[kibitz-bg] getMediaStreamId threw:', e && e.message)
        sendResponse({ err: 'getMediaStreamId threw: ' + (e && e.message ? e.message : String(e)) })
      }
    })
    return true // async response
  }
  return false
})
