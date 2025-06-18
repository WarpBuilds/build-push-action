FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*


RUN echo "Sleeping..." && \
    sleep 60 && \
    echo "Done sleeping!"   

CMD ["python3", "--version"]