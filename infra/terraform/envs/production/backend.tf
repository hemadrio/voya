terraform {
  backend "s3" {
    bucket         = "travel-platform-tfstate-production"
    key            = "production/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    kms_key_id     = "alias/production/platform/secretsmanager"
    dynamodb_table = "travel-platform-tfstate-lock-production"
  }

  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = {
      Project     = "travel-platform"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
