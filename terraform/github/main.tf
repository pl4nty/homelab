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

resource "github_repository" "this" {
  for_each = local.repos

  name                   = each.key
  archived               = each.value.archived
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

  security_and_analysis {
    secret_scanning {
      status = each.value.secret_scanning
    }
    secret_scanning_push_protection {
      status = each.value.secret_scanning
    }
  }

  lifecycle {
    # repos that leave the search results are forgotten, never deleted or archived
    destroy        = false
    ignore_changes = [description, homepage_url, has_downloads, ignore_vulnerability_alerts_during_read]
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

resource "github_repository_vulnerability_alerts" "this" {
  for_each = local.repos

  repository = github_repository.this[each.key].name
  enabled    = each.value.vulnerability_alerts

  lifecycle {
    destroy = false
  }
}

resource "github_actions_repository_permissions" "this" {
  for_each = local.repos

  repository      = github_repository.this[each.key].name
  enabled         = each.value.actions_enabled
  allowed_actions = "all"

  lifecycle {
    destroy = false
  }
}

resource "github_workflow_repository_permissions" "this" {
  for_each = local.repos

  repository                       = github_repository.this[each.key].name
  default_workflow_permissions     = each.value.default_workflow_permissions
  can_approve_pull_request_reviews = false

  lifecycle {
    destroy = false
  }
}

import {
  for_each = local.repos
  to       = github_repository.this[each.key]
  id       = each.key
}

import {
  for_each = local.archived
  to       = github_repository.archived[each.key]
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
