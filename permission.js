// One-time camera+mic permission grant for the Kibitz extension.
//
// WHY THIS PAGE EXISTS: a Chrome *side panel* can't show a grantable getUserMedia
// prompt — the prompt fires and auto-dismisses ("Permission dismissed"), so the
// panel's mic/cam never turn on. A normal extension window CAN grant it, and the
// grant is stored per extension origin (chrome-extension://<id>), shared by ALL
// the extension's pages — including the side panel. So the panel opens this tiny
// window, the user clicks Allow once, and the panel reuses the grant forever after.
const msg = document.getElementById('msg')
const go = document.getElementById('go')

async function grant() {
  go.disabled = true
  try {
    // Ask for both in one prompt; we only want the grant, so stop the tracks at once.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    stream.getTracks().forEach((t) => t.stop())
    msg.textContent = '✓ Enabled! Your camera and mic now work in the Kibitz panel. You can close this window.'
    msg.className = 'ok'
    go.style.display = 'none'
    try {
      chrome.runtime.sendMessage({ type: 'kibitz-media-granted' })
    } catch {
      /* no listener — the panel re-checks on its own */
    }
    setTimeout(() => window.close(), 1400)
  } catch (e) {
    msg.textContent = `Couldn’t enable (${e && e.name ? e.name : e}). If your browser blocked it, allow camera/mic for this extension, then try again.`
    msg.className = 'err'
    go.disabled = false
    go.textContent = 'Try again'
  }
}

go.onclick = grant
// The window was opened by a click in the panel, so we have fresh user activation —
// fire the prompt immediately; the button is the retry path if it's dismissed.
grant()
