locals {
  public = [
    ".github",
    "anutimetable",
    "auto-CTFd",
    "azure-favicons",
    "cloudflare-kubernetes-gateway",
    "ctfcli-deploy-azure",
    "ctfcli-deploy-kubernetes",
    "data",
    "dotfiles",
    "dotnet-setup-tools",
    "garden",
    "homelab",
    "intune-change-tracking",
    "ipa-track",
    "msedge",
    "pl4nty",
    "talos-sbc-riscv64",
    "web-admx-tool",
    "windows-ddf",
    "winget-extras",
    "winget-pkgs-selfhost",
    "zmk-config",
  ]

  private = [
    "action-ipadown",
    "allocateplus-viewer",
    "arm-sequencer",
    "arm-sequencer-networked",
    "arm-synth",
    "ataxx",
    "azure-fitbit",
    "cellular-automata",
    "comp1110-homework",
    "comp1110-labs",
    "fortinet-downloads",
    "hid-asure-id",
    "intune-apps",
    "intune-ibiza",
    "linewize-spoofer",
    "macrosign",
    "private-data",
    "proctorio-re",
    "quora-discord-notifs",
    "scratch",
    "shapes",
    "teams-upload-assignment",
    "temple-trap",
    "trump-pence.org",
    "tsuro",
  ]

  # GitHub's defaults for a new repo
  defaults = {
    is_template                  = false
    has_issues                   = true
    has_projects                 = true
    has_wiki                     = true
    has_discussions              = false
    allow_merge_commit           = true
    allow_squash_merge           = true
    allow_rebase_merge           = true
    allow_auto_merge             = false
    allow_update_branch          = false
    delete_branch_on_merge       = false
    vulnerability_alerts         = true
    actions_enabled              = true
    default_workflow_permissions = "read"
  }

  overrides = {
    "auto-CTFd"            = { is_template = true }
    homelab                = { delete_branch_on_merge = true }
    "winget-pkgs-selfhost" = { is_template = true }
  }

  repos = {
    for name in concat(local.public, local.private) : name => merge(
      local.defaults,
      {
        visibility = contains(local.public, name) ? "public" : "private"
        # secret scanning is free for public repos only
        secret_scanning = contains(local.public, name) ? "enabled" : "disabled"
      },
      lookup(local.overrides, name, {}),
    )
  }
}
