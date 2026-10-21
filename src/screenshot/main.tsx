import "../styles/globals.css";

import { ScreenshotOverlay } from "@/modules/screenshot/ScreenshotOverlay";
import ReactDOM from "react-dom/client";

// 截图覆盖窗口：不套 ThemeProvider —— 主题的背景层（SurfaceLayer）会盖在冻结的画面上。
// 这里也不用主题色，只用固定的几个颜色，所以没有主题也不会难看。
ReactDOM.createRoot(
  document.getElementById("screenshot-root") as HTMLElement,
).render(<ScreenshotOverlay />);