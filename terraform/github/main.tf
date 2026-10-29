terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket                      = "terraform"
    key                         = "github.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }

  required_providers {
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }
}

provider "github" {
  owner = "pl4nty"
}

resource "github_repository" "this" {
  for_each = local.repos

  name                   = each.key
  visibility             = each.value.visibility
  is_template            = each.value.is_template
  has_issues             = each.value.has_issues
  has_projects           = each.value.has_projects
  has_wiki               = each.value.has_wiki
  has_discussions        = each.value.has_discussions
  allow_merge_commit     = each.value.allow_merge_commit
  allow_squash_merge     = each.value.allow_squash_merge
  allow_rebase_merge     = each.value.allow_rebase_merge
  allow_auto_merge       = each.value.allow_auto_merge
  allow_update_branch    = each.value.allow_update_branch
  delete_branch_on_merge = each.value.delete_branch_on_merge
  archive_on_destroy     = true

  security_and_analysis {
    secret_scanning {
      status = each.value.secret_scanning
    }
    secret_scanning_push_protection {
      status = each.value.secret_scanning
    }
  }

  lifecycle {
    ignore_changes = [description, homepage_url, has_downloads]
  }
}

resource "github_repository_vulnerability_alerts" "this" {
  for_each = local.repos

  repository = github_repository.this[each.key].name
  enabled    = each.value.vulnerability_alerts
}

resource "github_actions_repository_permissions" "this" {
  for_each = local.repos

  repository      = github_repository.this[each.key].name
  enabled         = each.value.actions_enabled
  allowed_actions = "all"
}

resource "github_workflow_repository_permissions" "this" {
  for_each = local.repos

  repository                       = github_repository.this[each.key].name
  default_workflow_permissions     = each.value.default_workflow_permissions
  can_approve_pull_request_reviews = false
}

import {
  for_each = local.repos
  to       = github_repository.this[each.key]
  id       = each.key
}

import {
  for_each = local.repos
  to       = github_repository_vulnerability_alerts.this[each.key]
  id       = each.key
}

import {
  for_each = local.repos
  to       = github_actions_repository_permissions.this[each.key]
  id       = each.key
}

import {
  for_each = local.repos
  to       = github_workflow_repository_permissions.this[each.key]
  id       = each.key
}

check "unmanaged_repos" {
  data "github_repositories" "owned" {
    query = "user:pl4nty fork:false archived:false"
  }

  assert {
    condition     = length(setsubtract(data.github_repositories.owned.names, keys(local.repos))) == 0
    error_message = "Not in repos.tf yet: ${join(", ", setsubtract(data.github_repositories.owned.names, keys(local.repos)))}"
  }
}
