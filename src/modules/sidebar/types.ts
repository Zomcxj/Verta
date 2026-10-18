/**
 * 左栏里能选的面板。Git 视图不在这里：它搬到了右侧面板，入口只有右上角那个按钮与命令面板，
 * 免得同一个面板有两处入口、两份状态。
 */
export type SidebarViewId = "explorer" | "launcher";