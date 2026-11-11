---
id: role/video-generator
title: The Video Generator
order: 8
summary: Short clips from prompts — the moving-picture sibling.
---

# The Video Generator

The **Video Generator** is the moving-picture sibling of the Image Generator: describe a shot, get a short clip. Product teasers, animated backgrounds, little social moments — generated on whatever video model your device or provider offers, delivered into the project's artifacts.

Like its sibling, it's fixed-function by design: no file editing, no workspace access, just generation. Short clips take real compute — on local hardware expect renders to be measured in minutes, not seconds, and lean on the smallest length that sells the idea.

## Animating a picture

Attach a picture to your message and the Video Generator animates it: the picture becomes the clip's first frame and sets its shape, and your words say how it should move ("the waves roll in, the camera drifts closer"). Send a picture with no words and it moves gently, with a slow push in.

Not every video model can start from a picture. When the model you use makes clips from words only, the Video Generator says so rather than quietly ignoring your picture. A model's description in Settings → Video generation says whether it starts from a picture.

## Smaller models

Some video models come in compact builds that run on your graphics card, whether that's Apple Silicon, NVIDIA, AMD or Intel, in a fraction of the memory the full models need. They save clips as WebM, which Gezel plays. If ffmpeg is installed on your computer, Gezel also saves an MP4 copy, which PowerPoint, Keynote and phones play.

::handboek-gezel-roster{role=video-generator}

## Their character

::handboek-role-about{role=video-generator}

## What they can do

::handboek-role-tools{role=video-generator scope=default}

### On this device

::handboek-role-tools{role=video-generator scope=device}

### As models grow

::handboek-role-tools{role=video-generator scope=tiers}

## Plans they run well

::handboek-craftbook-list{role=video-generator}
