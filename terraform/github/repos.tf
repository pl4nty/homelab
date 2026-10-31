data "github_repositories" "active" {
  query            = "user:pl4nty fork:true archived:false"
  results_per_page = 100
}

data "github_repositories" "forks" {
  query            = "user:pl4nty fork:only archived:false"
  results_per_page = 100
}

data "github_repositories" "private" {
  query            = "user:pl4nty fork:true archived:false is:private"
  results_per_page = 100
}

data "github_repositories" "archived" {
  query            = "user:pl4nty fork:true archived:true"
  results_per_page = 100
}

locals {
  forks   = toset(data.github_repositories.forks.names)
  private = toset(data.github_repositories.private.names)

  overrides = {
    "auto-CTFd"            = { is_template = true }
    homelab                = { delete_branch_on_merge = true }
    "winget-pkgs-selfhost" = { is_template = true }
  }

  # GitHub's defaults for a new repo or fork
  repos = {
    for name in data.github_repositories.active.names : name => merge(
      {
        archived                     = false
        is_template                  = false
        has_issues                   = !contains(local.forks, name)
        has_projects                 = true
        has_wiki                     = true
        has_discussions              = false
        allow_merge_commit           = true
        allow_squash_merge           = true
        allow_rebase_merge           = true
        allow_auto_merge             = false
        allow_update_branch          = false
        delete_branch_on_merge       = false
        vulnerability_alerts         = !contains(local.forks, name)
        actions_enabled              = true
        default_workflow_permissions = "read"
        # free for public repos only
        secret_scanning = contains(local.private, name) ? "disabled" : "enabled"
      },
      lookup(local.overrides, name, {}),
    )
  }

  archived = toset(data.github_repositories.archived.names)
}
