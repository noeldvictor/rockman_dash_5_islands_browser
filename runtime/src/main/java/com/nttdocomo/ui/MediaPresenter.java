package com.nttdocomo.ui;

public interface MediaPresenter {
    MediaResource getMediaResource();

    void play();

    void stop();

    void setAttribute(int attr, int value);

    void setMediaListener(MediaListener listener);
}
