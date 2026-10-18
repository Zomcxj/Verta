//! 远程仓库列表：借本机已登录的 gh CLI 取当前账号能访问的仓库。
//!
//! 只做列表（P5 的最小切片）：Releases / Actions / CI / 下载都不在这里。

pub mod commands;
mod gh;
mod repos;
pub mod types;