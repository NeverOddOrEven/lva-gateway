---
title: 'Tutorial - Create a live video analytics IoT Edge instance in Azure IoT Central (Intel NUC)'
description: This tutorial shows how to create a live video analytics IoT Edge instance to use with the security and safety video analytics application template.
services: iot-central
ms.service: iot-central
ms.subservice: iot-central-retail
ms.topic: tutorial
ms.author: nandab
author: KishorIoT
ms.date: 07/01/2020
---
# Tutorial: Create an IoT Edge instance for live video analytics (Intel NUC)

Azure IoT Edge is a fully managed service that delivers cloud intelligence locally by deploying and running:

* Custom logic
* Azure services
* Artificial intelligence

In IoT Edge, these services run directly on cross-platform IoT devices. This enables you to run your IoT solution securely and at scale in the cloud or offline.

This tutorial shows you how to install and configure the IoT Edge runtime on an Intel NUC device.

In this tutorial, you learn how to:
> [!div class="checklist"]
> * Update and configure Edge
> * Setup the gateway with a configuration file with one-time secrets that should not be transferable from the cloud.
> * join a local ONVIF camera to your NUC for video analysis

## Prerequisites

* A device, such as an Intel NUC, running Linux, capable of running Docker containers, and enough processing power to run video analysis.
* The IoT Edge runtime installed and running on the device.
* To connect to the IoT Edge device from your Windows machine, you need the [PuTTY SSH client](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html) or an equivalent utility.
* Before you start, you should complete the previous [Create a live video analytics application in Azure IoT Central](./tutorial-public-safety-create-app.md) tutorial.
* You also need an Azure subscription. If you don't have an Azure subscription, you can create one for free on the [Azure sign-up page](https://aka.ms/createazuresubscription).

## Configure the IoT Edge device

If you don't have the IoT Edge runtime installed in your Intel NUC machine, see [Install the Azure IoT Edge runtime on Debian-based Linux systems](https://docs.microsoft.com/azure/iot-edge/how-to-install-iot-edge-linux) instructions.

To update the IoT Edge runtime:

1. Use the PuTTY utility to connect to the IoT Edge device.

1. Run the following commands to update and check the version of the IoT Edge runtime. At the time of writing, the version is 1.0.9:

    ```bash
    sudo apt-get update
    sudo apt-get install libiothsm iotedge
    sudo iotedge --version
    ```

To add the *state.json* configuration file to the */data/storage* folder:

1. Use the following commands to create the folders with the necessary permissions:

    ```bash
    sudo mkdir -p /data/storage
    sudo mkdir -p /data/media
    sudo chmod -R 777 /data
    ```

    <!-- TODO - we need instructions for creating the state.json file here - it wasn't done in the previous tutorial -->
1. Use the PuTTY `scp` utility in a command prompt to copy the *state.json* file you created in the previous tutorial into the IoT Edge device. This example uses `40.121.209.246` as an example IP address, replace it with the IP address of your IoT Edge device:

    ```cmd
    scp state.json YourUserName@40.121.209.246:/data/storage/state.json`
    ```

Configure IoT Edge to register and connect to your IoT Central application:

1. Use a text editor, such as `nano`, to open the IoT Edge config.yaml file.

    ```bash
    sudo nano /etc/iotedge/config.yaml
    ```

    > [!WARNING]
    > YAML files can't use tabs for indentation, use two spaces instead. Top-level items can't have leading whitespace.

1. Scroll down until you see `# Manual provisioning configuration`. Comment out the next three lines as shown in the following snippet:

    ```yaml
    # Manual provisioning configuration
    #provisioning:
    #  source: "manual"
    #  device_connection_string: "temp"
    ```

1. Scroll down until you see `# DPS symmetric key provisioning configuration`. Uncomment the next eight lines as shown in the following snippet:

    ```yaml
    # DPS symmetric key provisioning configuration
    provisioning:
      source: "dps"
      global_endpoint: "https://global.azure-devices-provisioning.net"
      scope_id: "{scope_id}"
      attestation:
        method: "symmetric_key"
        registration_id: "{registration_id}"
        symmetric_key: "{symmetric_key}"
    ```

1. Replace `{scope_id}` with the **ID Scope** you made a note of in the previous tutorial.

1. Replace `{registration_id}` with *lva-gateway-001*, the device you created in the previous tutorial.

1. Replace `{symmetric_key}` with the **Primary key** for the **lva-gateway-001** device you made a note of in the previous tutorial.

1. Run the following command to restart the IoT Edge daemon:

    ```bash
    sudo systemctl restart iotedge
    ```

1. To check the status of the IoT Edge modules, run the following command:

    ```bash
    iotedge list
    ```

    The output from the pervious command shows five running modules. You can also view the status of the running modules in your IoT Central application.

    > [!TIP]
    > You can rerun this command to check on the status. You may need to wait for all the modules to start running.

If the IoT Edge modules don't start correctly, see [Troubleshoot your IoT Edge device](../../iot-edge/troubleshoot.md).

## Collect the RSTP stream from your camera

Locate the RTSP Stream URLs for the cameras connected to your IoT Edge device.

Example: HiKvision
`rtsp://<address>:<port>/Streaming/Channels/<id>/`

Main Stream
`rtsp://192.168.1.64:554/Streaming/Channels/101/`

> [!TIP]
> Try to view the camera stream on the IoT Edge computer using a media player such as VLC.

## Next steps

You have now deployed the IoT Edge runtime and the LVA modules to the Intel NUC gateway device.

To manage the cameras, follow the next tutorial:

> [!div class="nextstepaction"]
> [Monitor and manage a security and safety video analytics application](./tutorial-public-safety-manage.md)
