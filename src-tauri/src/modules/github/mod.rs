//! GitHub panel: use the locally logged-in gh CLI to fetch the repositories the current
//! account can reach, CI status, run lists and run details (job/step and logs), and to
//! rerun / cancel a run.
//!
//! Releases and asset downloads come in a later slice.

mod actions;
mod activity;
mod auth;
mod ci;
pub mod commands;
mod gh;
mod issues;
mod permission;
mod releases;
mod repo_admin;
mod repos;
pub mod types;
