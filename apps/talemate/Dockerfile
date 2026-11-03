# Stage 1: Frontend build (static assets, so build once on the native platform)
FROM --platform=$BUILDPLATFORM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS frontend-build

ENV NODE_ENV=development

WORKDIR /app

# Copy the frontend directory contents into the container at /app
COPY --from=src ./talemate_frontend /app

# Install all dependencies and build
RUN --mount=type=cache,id=npm,target=/root/.npm npm install && npm run build

# Stage 2: Backend build
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93 AS backend-build

WORKDIR /app

# Install system dependencies
RUN --mount=type=cache,id=apt-lists-py311,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    bash \
    gcc

# Install poetry
RUN --mount=type=cache,id=pip,target=/root/.cache/pip pip install poetry

# Copy poetry files
COPY --from=src pyproject.toml poetry.lock* /app/

# Create a virtual environment
RUN python -m venv /app/talemate_env

# Activate virtual environment and install dependencies
RUN --mount=type=cache,id=poetry,target=/root/.cache/pypoetry \
    . /app/talemate_env/bin/activate && \
    poetry config virtualenvs.create false && \
    poetry install  --only main --no-root

# Copy the Python source code
COPY --from=src ./src /app/src

# Conditional PyTorch+CUDA install
ARG CUDA_AVAILABLE=false
RUN . /app/talemate_env/bin/activate && \
    if [ "$CUDA_AVAILABLE" = "true" ]; then \
        echo "Installing PyTorch with CUDA support..." && \
        pip uninstall torch torchaudio -y && \
        pip install torch~=2.4.1 torchaudio~=2.4.1 --index-url https://download.pytorch.org/whl/cu121; \
    fi

# Stage 3: Final image
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

WORKDIR /app

RUN apt-get update && apt-get install -y \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from backend-build stage
COPY --from=backend-build /app/talemate_env /app/talemate_env

# Copy Python source code
COPY --from=backend-build /app/src /app/src

# Copy Node.js build artifacts from frontend-build stage
COPY --from=frontend-build /app/dist /app/talemate_frontend/dist

# Copy the frontend WSGI file if it exists
COPY --from=src frontend_wsgi.py /app/frontend_wsgi.py

# Copy base config
COPY --from=src config.example.yaml /app/config.yaml

# Copy essentials
COPY --from=src scenes scenes
COPY --from=src templates templates
COPY --from=src chroma* .

# Set PYTHONPATH to include the src directory
ENV PYTHONPATH=/app/src

# Make ports available to the world outside this container
EXPOSE 5050
EXPOSE 8080

# Use bash as the shell, activate the virtual environment, and run backend server
CMD ["/bin/bash", "-c", "source /app/talemate_env/bin/activate && python src/talemate/server/run.py runserver --host 0.0.0.0 --port 5050 --frontend-host 0.0.0.0 --frontend-port 8080"]
