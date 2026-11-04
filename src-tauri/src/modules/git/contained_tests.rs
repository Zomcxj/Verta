use super::*;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "verta-contained-{label}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn as_repo(dir: &Path) {
    std::fs::create_dir_all(dir.join(".git")).expect(".git");
}

#[test]
fn names_the_folder_it_was_given_when_that_is_a_repository() {
    let root = scratch("self");
    as_repo(&root);
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert_eq!(out, vec![root.clone()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn does_not_look_inside_a_repository_for_more_repositories() {
    // A checkout's own nested directories belong to it; naming them would show the same tree twice
    // and offer a repository the panel never meant to drive.
    let root = scratch("nested");
    as_repo(&root);
    as_repo(&root.join("inner"));
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert_eq!(out, vec![root.clone()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn stops_at_a_repository_so_its_children_are_not_listed() {
    let root = scratch("stop");
    let one = root.join("one");
    let two = root.join("one/two");
    as_repo(&one);
    as_repo(&two);
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert_eq!(out, vec![one.clone()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn one_level_down_is_found() {
    let root = scratch("onelevel");
    let a = root.join("site");
    as_repo(&a);
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert_eq!(out, vec![a.clone()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_levels_of_plain_folders_are_reached() {
    let root = scratch("plain");
    let deep = root.join("a").join("b");
    as_repo(&deep);
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert_eq!(out, vec![deep.clone()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn three_levels_down_is_not_reached() {
    let root = scratch("toolow");
    let too_deep = root.join("a").join("b").join("c");
    as_repo(&too_deep);
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert!(out.is_empty(), "{out:?}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn skips_dot_directories() {
    let root = scratch("dots");
    as_repo(&root.join(".hidden"));
    let mut out = Vec::new();
    collect(&root, 0, &mut out);
    assert!(out.is_empty(), "{out:?}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn answers_in_the_spelling_the_caller_used() {
    let local = Path::new("C:/work");
    let found = Path::new("C:/work/site");
    assert_eq!(display_path(found, "C:/work/", local), "C:/work/site");
    assert_eq!(display_path(local, "C:/work/", local), "C:/work");
}

#[test]
fn a_repository_keep_name_is_reported_at_the_folder_itself() {
    // The scan walks canonical directories; the answer has to be the caller's spelling of them.
    let local = Path::new("D:/VsPro/Verta");
    assert_eq!(display_path(local, "D://VsPro//Verta", local), "D://VsPro//Verta");
}
