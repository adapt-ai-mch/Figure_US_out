// Save one of a run's files where the person chooses. Chrome, Edge, Brave and Arc open the computer's own
// Save dialog (folder and name); Safari and Firefox download it the way they are set to (by default into
// the Downloads folder, or asking where if that setting is on).

type SaveFilePicker = (options: {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>

export type FileKind = "tiff" | "jpeg" | "svg" | "png"

const KINDS: Record<FileKind, { description: string; mime: string; ext: string }> = {
  tiff: { description: "TIFF image", mime: "image/tiff", ext: ".tiff" },
  jpeg: { description: "JPEG image", mime: "image/jpeg", ext: ".jpeg" },
  svg: { description: "SVG image", mime: "image/svg+xml", ext: ".svg" },
  png: { description: "PNG image", mime: "image/png", ext: ".png" },
}

function picker(): SaveFilePicker | undefined {
  const fn = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  return typeof fn === "function" ? fn.bind(window) : undefined
}

/** True when this browser can ask where to save (a Save dialog with folder and name). */
export const canChooseFolder = () => picker() !== undefined

function download(url: string, name: string) {
  const a = document.createElement("a")
  a.href = url + (url.includes("?") ? "&" : "?") + "download=true"
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
}

/**
 * Save the file at `url` as `name`. "saved": written where the person chose; "downloaded": handed to the
 * browser's own downloads; "cancelled": the person closed the Save dialog.
 */
export async function saveFile(url: string, name: string, kind: FileKind): Promise<"saved" | "downloaded" | "cancelled"> {
  const show = picker()
  if (!show) {
    download(url, name)
    return "downloaded"
  }
  const k = KINDS[kind]
  let handle
  try {
    // The dialog has to open straight from the click, so nothing is awaited before it.
    handle = await show({ suggestedName: name, types: [{ description: k.description, accept: { [k.mime]: [k.ext] } }] })
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled"
    if (e instanceof DOMException && (e.name === "SecurityError" || e.name === "NotAllowedError")) {
      download(url, name)
      return "downloaded"
    }
    throw e
  }
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`the server could not read the file (${res.status})`)
  await res.body.pipeTo(await handle.createWritable()) // closes the file when done
  return "saved"
}
