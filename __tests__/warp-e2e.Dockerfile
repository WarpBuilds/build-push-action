FROM alpine:3.22
RUN echo "warp-e2e" > /ok.txt
CMD ["cat", "/ok.txt"]
