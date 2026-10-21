//! GitHub 面板：借本机已登录的 gh CLI 取当前账号能访问的仓库、CI 状态、运行列表与运行详情
//! （job/step 与日志），并能重跑/取消一次运行。
//!
//! Releases 与资产下载留给后续切片。

mod actions;
mod ci;
pub mod commands;
mod gh;
mod permission;
mod releases;
mod repos;
pub mod types;
