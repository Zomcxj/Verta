//! GitHub 面板：借本机已登录的 gh CLI 取当前账号能访问的仓库，以及单个仓库的 CI 状态。
//!
//! Releases / Actions 明细 / 下载留给后续切片。

pub mod commands;
mod ci;
mod gh;
mod repos;
pub mod types;