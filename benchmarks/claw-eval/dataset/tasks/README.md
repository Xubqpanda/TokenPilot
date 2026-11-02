# Claw-Eval task fixtures

This directory keeps the task definitions and graders in Git:

- `task.yaml`
- `grader.py`

Large task-local fixture payloads are stored outside Git:

- `fixtures/` media files
- task-local PDFs and OCR inputs
- task-local JSON fixture bundles
- generated `output.html` reference files

Download the external data bundle here:

- <https://drive.google.com/drive/folders/1UvKMp4QwdLg2Ge4Me83tYAQ8FKs_P2zZ>

## Expected restore layout

After download, restore the full task tree under:

```text
benchmarks/claw-eval/dataset/tasks/
```

Uploading the whole `tasks/` directory is recommended in practice. It avoids
manual per-task fixture selection and makes fresh-machine restore simpler.
