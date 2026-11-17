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
  overrides = {
    anutimetable                  = { allow_auto_merge = true, delete_branch_on_merge = true }
    cloudflare-kubernetes-gateway = { delete_branch_on_merge = true }
    dotfiles                      = { allow_merge_commit = false, allow_squash_merge = false }
    homelab                       = { delete_branch_on_merge = true }
    windows-ddf                   = { archived = true }
    winget-extras                 = { allow_auto_merge = true, allow_update_branch = true, delete_branch_on_merge = true }
    winget-recipes                = { allow_auto_merge = true, allow_update_branch = true, delete_branch_on_merge = true }
  }

  # GitHub's defaults for a new repo
  repos = {
    for name in data.github_repositories.active.names : name => merge(
      {
        archived               = false
        allow_merge_commit     = true
        allow_squash_merge     = true
        allow_rebase_merge     = true
        allow_auto_merge       = false
        allow_update_branch    = false
        delete_branch_on_merge = false
      },
      lookup(local.overrides, name, {}),
    )
  }

  private  = { for name, repo in local.repos : name => repo if contains(data.github_repositories.private.names, name) }
  public   = { for name, repo in local.repos : name => repo if !contains(data.github_repositories.private.names, name) }
  sources  = setsubtract(keys(local.repos), data.github_repositories.forks.names)
  archived = toset(data.github_repositories.archived.names)
}
