//! GitHub 面板：借本机已登录的 gh CLI 取当前账号能访问的仓库、CI 状态与运行列表，
//! 并能重跑/取消一次运行。
//!
//! Releases 与资产下载留给后续切片。

mod actions;
mod ci;
pub mod commands;
mod gh;
mod repos;
pub mod types;
