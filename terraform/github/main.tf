terraform {
  # lifecycle { destroy = false }
  required_version = ">= 1.13"

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

resource "github_repository" "public" {
  for_each = local.public

  name                   = each.key
  archived               = each.value.archived
  allow_merge_commit     = each.value.allow_merge_commit
  allow_squash_merge     = each.value.allow_squash_merge
  allow_rebase_merge     = each.value.allow_rebase_merge
  allow_auto_merge       = each.value.allow_auto_merge
  allow_update_branch    = each.value.allow_update_branch
  delete_branch_on_merge = each.value.delete_branch_on_merge

  security_and_analysis {
    secret_scanning {
      status = "enabled"
    }
    secret_scanning_push_protection {
      status = "enabled"
    }
  }

  lifecycle {
    # repos that leave the search results are forgotten, never deleted or archived
    destroy        = false
    ignore_changes = [description, homepage_url, has_downloads, has_issues, has_projects, has_wiki, has_discussions, is_template, template, ignore_vulnerability_alerts_during_read]
  }
}

# secret scanning isn't available on private repos
resource "github_repository" "private" {
  for_each = local.private

  name                   = each.key
  archived               = each.value.archived
  allow_merge_commit     = each.value.allow_merge_commit
  allow_squash_merge     = each.value.allow_squash_merge
  allow_rebase_merge     = each.value.allow_rebase_merge
  allow_auto_merge       = each.value.allow_auto_merge
  allow_update_branch    = each.value.allow_update_branch
  delete_branch_on_merge = each.value.delete_branch_on_merge

  lifecycle {
    destroy        = false
    ignore_changes = [description, homepage_url, has_downloads, has_issues, has_projects, has_wiki, has_discussions, is_template, template, ignore_vulnerability_alerts_during_read, security_and_analysis]
  }
}

# GitHub rejects every change to an archived repo, so only track that it exists
resource "github_repository" "archived" {
  for_each = local.archived

  name     = each.key
  archived = true

  lifecycle {
    destroy        = false
    ignore_changes = all
  }
}

# forks run upstream code, so only their repo settings are managed
resource "github_repository_vulnerability_alerts" "this" {
  for_each = local.sources

  repository = each.key
  enabled    = true

  lifecycle {
    destroy = false
  }
}

resource "github_actions_repository_permissions" "this" {
  for_each = local.sources

  repository      = each.key
  enabled         = true
  allowed_actions = "all"

  lifecycle {
    destroy = false
  }
}

resource "github_workflow_repository_permissions" "this" {
  for_each = local.sources

  repository                       = each.key
  default_workflow_permissions     = local.repos[each.key].default_workflow_permissions
  can_approve_pull_request_reviews = local.repos[each.key].can_approve_pull_request_reviews

  lifecycle {
    destroy = false
  }
}

import {
  for_each = local.public
  to       = github_repository.public[each.key]
  id       = each.key
}

import {
  for_each = local.private
  to       = github_repository.private[each.key]
  id       = each.key
}

import {
  for_each = local.archived
  to       = github_repository.archived[each.key]
  id       = each.key
}

import {
  for_each = local.sources
  to       = github_repository_vulnerability_alerts.this[each.key]
  id       = each.key
}

import {
  for_each = local.sources
  to       = github_actions_repository_permissions.this[each.key]
  id       = each.key
}

import {
  for_each = local.sources
  to       = github_workflow_repository_permissions.this[each.key]
  id       = each.key
}
