package com.nttdocomo.ui;

import com.nttdocomo.io.ConnectionException;

public interface MediaResource {
    int UNUSE = 0;
    int USE = 1;
    int DISPOSE = 2;

    void use() throws ConnectionException;

    void use(MediaResource overwritten, boolean useOnce) throws ConnectionException;

    void unuse();

    void dispose();

    String getProperty(String key);

    void setProperty(String key, String value);

    boolean isRedistributable();

    boolean setRedistributable(boolean redistributable);
}
