docker build --platform linux/amd64  -t wxyc_backend_service:latest .
docker tag wxyc_backend_service:latest 203767826763.dkr.ecr.us-east-1.amazonaws.com/wxyc_backend_service:latest
docker push 203767826763.dkr.ecr.us-east-1.amazonaws.com/wxyc_backend_service:latest