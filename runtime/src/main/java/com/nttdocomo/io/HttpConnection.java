package com.nttdocomo.io;

import java.io.IOException;

import javax.microedition.io.ContentConnection;

public interface HttpConnection extends ContentConnection {
    String GET = "GET";
    String HEAD = "HEAD";
    String POST = "POST";
    int HTTP_OK = 200;

    void connect() throws IOException;

    void setRequestMethod(String method) throws IOException;

    void setRequestProperty(String key, String value) throws IOException;

    int getResponseCode() throws IOException;

    String getResponseMessage() throws IOException;

    String getHeaderField(String name);

    String getURL();
}
