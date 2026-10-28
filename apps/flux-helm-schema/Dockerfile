FROM python:3.14-slim@sha256:ce40764625a4ff50df3548277632e7f96c4e77fe75fa848aae9885476e7df5a4

# Install necessary dependencies
RUN pip install fastapi uvicorn requests

# Copy the Python project files into the container
COPY . /app

# Set the working directory
WORKDIR /app

# Set the entry point to run the web API
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
