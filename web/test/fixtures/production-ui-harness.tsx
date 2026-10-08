import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router";
import ProductionPage from "../../src/pages/production";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import "./production-ui-runtime";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.body.style.background = "var(--background)";
document.body.style.margin = "0";
const router = createMemoryRouter([{ path: "/canvas/:id/production", element: <ProductionPage /> }, { path: "/canvas/:id", element: <p>已返回作品</p> }], { initialEntries: ["/canvas/canvas/production"] });
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={getAntThemeConfig(dark)}><App><RouterProvider router={router} /></App></ConfigProvider>);
