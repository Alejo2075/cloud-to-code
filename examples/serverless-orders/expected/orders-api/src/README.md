# Application source code

Cloud to Code reads deployed **configuration only**. It never downloads Lambda deployment packages, and deployed code cannot reconstruct your original repository, so no application source is included or invented.

Each Lambda function in the stack reads its code location from CloudFormation parameters. Build and upload your own artifacts, then pass the bucket and key at deploy time.
