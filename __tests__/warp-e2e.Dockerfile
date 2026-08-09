FROM alpine:3.22
ARG MARKER=unset
RUN echo "$MARKER" > /ok.txt
CMD ["cat", "/ok.txt"]
