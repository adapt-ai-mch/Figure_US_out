import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactLenis } from 'lenis/react'
import 'lenis/dist/lenis.css'
import './index.css'
import App from './App.tsx'
import { watchTheme } from './lib/theme'

watchTheme()

// Lenis smooths wheel and trackpad scrolling of the whole page (the smooth-scroll style); with
// "Reduce motion" on, the page scrolls normally. Inner scroll areas carry data-lenis-prevent.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactLenis root options={{ lerp: 0.12, smoothWheel: !reduceMotion }}>
      <App />
    </ReactLenis>
  </StrictMode>,
)
