# Slice 7 feasibility probe (#147): a minimal container that returns a fixed
# marker, to test whether a Workers for Platforms dispatch-namespace user
# Worker can launch a Container at all. NOT the c1 WordPress image.
FROM python:3.13-alpine
WORKDIR /app
COPY server.py /app/server.py
EXPOSE 8080
CMD ["python3", "/app/server.py"]
