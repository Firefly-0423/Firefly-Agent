import type { ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { FeedbackProvider } from "../../components/feedback/FeedbackProvider";
import { useChatAppearance } from "../../hooks/useChatAppearance";
import { useUiTheme } from "../../hooks/useUiTheme";
import { isDarkUiTheme } from "../../../../shared/ui-theme";

interface AppProvidersProps {
  children: ReactNode;
}

/** antd draws its own surfaces (inputs, popovers, menus), so it needs to know which theme is active. */
const ANTD_TOKENS = {
  "pearl-white": { colorPrimary: "#4d4e69", colorBgBase: "#f5f6f9", colorTextBase: "#3d3e55" },
  "firefly-dark": { colorPrimary: "#7bd8ae", colorBgBase: "#141c19", colorTextBase: "#e4eee9" },
} as const;

export function AppProviders({ children }: AppProvidersProps) {
  // 主题状态初始化后再挂反馈层，保证 Token 就绪
  useChatAppearance();
  const uiTheme = useUiTheme();
  const dark = isDarkUiTheme(uiTheme);
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { ...ANTD_TOKENS[uiTheme], borderRadius: 12, fontFamily: "inherit" },
      }}
    >
      <FeedbackProvider>{children}</FeedbackProvider>
    </ConfigProvider>
  );
}
