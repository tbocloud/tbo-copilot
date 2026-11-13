---
name: Website update on AWS
description: Use when someone wants to publish a new version of TBO's website (S3 + CloudFront): back up the bucket, upload the new files, invalidate CloudFront. Three changes, each approved in Teams.
---

# Website update (S3 and CloudFront)

The website is static files in an S3 bucket behind a CloudFront distribution. Their names are in the plugin's
settings ("Website bucket" and "Website CloudFront distribution"); `tbo_aws` `status` shows them. If either says
"(not set)", ask the person to fill it in from TBO's internal AWS notes, and stop.

Every step that changes something is a `change`: "Allow AWS changes" must be on, and each command needs its own
approval in Teams. Do them in this order, and only start a step when the one before it worked.

## 0. Look first (reads)

- `aws s3 ls s3://<bucket>/ --summarize`: how many files and bytes are live now.
- `aws cloudfront get-distribution --id <distribution>`: the distribution is `Deployed` and its origin is the bucket.

## 1. Back up the live site

Copy the live files to a backup location that is **not** the website bucket (anything in the website bucket is
public). Ask the person which bucket the backups go to if they have not said, and use a dated prefix:

`aws s3 cp s3://<bucket> s3://<backup bucket>/website-backups/<YYYY-MM-DD-HHMM>/ --recursive`

Ask (`change` with a reason), wait for the approval, run it, then list the backup to show it is there.

## 2. Upload the new version

The AWS server only reads local files inside its work folder (`work_folder` in `status`). The person (or you, with
their permission) puts the new build in a folder there, for example `<work folder>/site-2026-11-12/`. Then:

`aws s3 cp "<work folder>/site-2026-11-12" s3://<bucket>/ --recursive`

`cp --recursive` writes every file of the build, whatever its size or date (`sync` can skip a changed file of the
same size). The approval covers the build's content, not just the folder's name: the tool hashes every file when it
asks, and the approver's card shows the number of files and the hash. If any file changes before "run it", the
hashes no longer match and the tool asks for a new approval instead of uploading. So finish the build first, then ask.

Never with `--delete` (blocked): files that are no longer in the build stay in the bucket, which is safe; removing
them is for TBO's admins. Ask, wait, run, and say how many files were uploaded.

## 3. Invalidate CloudFront

`aws cloudfront create-invalidation --distribution-id <distribution> --paths "/*"`

Ask, wait, run, then `aws cloudfront get-invalidation --distribution-id <distribution> --id <id>` until it says
`Completed` (a few minutes). Tell the person the site is live, with the backup's location in case it has to go back.

## To go back

1. `aws s3 cp s3://<backup bucket>/website-backups/<YYYY-MM-DD-HHMM>/ s3://<bucket>/ --recursive`: every backed-up
   file overwrites the live one (an approval, like any change).
2. Files that only the failed release added are still in the bucket, and Copilot never deletes. List them for the
   person (the live bucket's files that are not in the backup) and ask TBO's admins to remove them in the AWS console.
3. Invalidate CloudFront as in step 3, once the admins say the extra files are gone.
