---
title: 'Tutorial - Create a live video analytics application in Azure IoT Central'
description: This tutorial shows how to create a live video analytics application in IoT Central. You create it, customize it, and connect it to other Azure services.
services: iot-central
ms.service: iot-central
ms.subservice: iot-central-retail
ms.topic: tutorial
author: KishorIoT
ms.author: nandab
ms.date: 07/01/2020
---
# Tutorial: Create a live video analytics application in Azure IoT Central

The tutorial shows solution builders how to create a live video analytics application using the IoT Central **Public Safety** application template, AzureIoT Edge devices, and Azure Media Services. The solution uses a retail store to show how to meet the common business need to monitor security cameras. The solution uses automatic object detection in a video feed to quickly identify and locate interesting events.

The sample application includes two simulated devices and one IoT Edge gateway. The following tutorials show two approaches to experiment and understand the capabilities of the gateway:

* Create the IoT Edge gateway in an Azure VM and connect a simulated camera.
* Create the IoT Edge gateway on a real device such as an Intel NUC and connect a real camera.

<!-- TODO - make sure to summarize the key learning steps of this tutorial -->

In this tutorial, you learn how to:
> [!div class="checklist"]
> * Use the Azure IoT Central **Public Safety** application template to create a retail store application
> * Customize the application settings
> * Create a device template for an IoT Edge gateway device
> * Add a gateway device to your IoT Central application

## Prerequisites

<!-- TODO - clarify the prereqs for completing this tutorial -->

To complete this tutorial series, you need:

* An Azure subscription. If you don't have an Azure subscription, you can create one on the [Azure sign-up page](https://aka.ms/createazuresubscription).
* If you're using a real camera, you need connectivity between the IoT Edge device and the camera, and you need the Real Time Streaming Protocol channel.

## Create an application

In this section, you create a new Azure IoT Central application from a template. You'll use this application throughout the tutorial series to build a complete solution.

To create a new Azure IoT Central application:

1. Navigate to the [Azure IoT Central application manager](https://aka.ms/iotcentral) website.

1. Sign in with the credentials you use to access your Azure subscription.

1. To start creating a new Azure IoT Central application, select **New Application**.

1. Select **Retail**.  The retail page displays several retail application templates.

To create a new live video analytics application:  

<!-- TODO - make sure the next statement gives a brief overview of the template contents -->

<!-- NOTE - The template is not available yet, use this private template in the meantime <https://apps.azureiotcentral.com/build/new/4d253e63-3ecc-41fc-b333-512bc3c822e1> -->

1. Select the **Public Safety** application template. This template includes device templates for all devices used in the tutorial. The template also provides an operator dashboard for monitoring the video.

1. Optionally, choose a friendly **Application name**. This application is based on a fictional retail store named Northwind Traders. The tutorial uses the **Application name** *Northwind Traders video analytics*.

    > [!NOTE]
    > If you use a friendly **Application name**, you still must use a unique value for the application **URL**.

    <!-- Given that you need a subscription for AMS, is it worth mentioning the free trial? -->
1. If you have an Azure subscription, select your **Directory**, **Azure subscription**, and **United States** as the **Location**. If you don't have a subscription, you can enable **7-day free trial** and complete the required contact information. This tutorial uses three devices - two cameras and an IoT Edge device - so if you don't use the free trial you will be billed for usage.

    For more information about directories, subscriptions, and locations, see the [create an application quickstart](../core/quick-deploy-iot-central.md).

1. Select **Create**.

    :::image type="content" source="./media/tutorial-public-safety-create-app/new-application.png" alt-text="Azure IoT Central Create Application page":::

### Retrieve the configuration data

Later in this tutorial when you configure the IoT Edge gateway, you need some configuration data from the IoT Central application. The IoT Edge device needs this information to register with, and connect to, the application.

In the **Administration** section, select **Your application** and make a note of the **Application URL** and the **Application ID**:

:::image type="content" source="./media/tutorial-public-safety-create-app/administration.png" alt-text="Administration":::

Select **API Tokens** and generate a new token for the **Operator** role:

:::image type="content" source="./media/tutorial-public-safety-create-app/token.png" alt-text="Generate Token":::

> [!TIP]
> When the token is generated, make a note of it for later. After the dialog closes you can't view the token again.

In the **Administration** section, select **Device connection**, and then select **View Keys**.

<!-- Should we make a note of the Scope ID here as well? -->
<!-- Should we specify Devices or IoT Edge devices? -->
Make a note of this **Primary key**. You use this *primary group shared access signature token* later when you configure the IoT Edge device.

## Configure Azure Media Services

The solution uses an Azure Media Services account to store the object detections made by the IoT Edge gateway device.

You can create a [Media Services account in the Azure portal](https://portal.azure.com/?r=1#create/Microsoft.MediaService).

When you create the Media Services account, you need to provide an account name, an Azure subscription, a location, a resource group, and a storage account. Choose the **East US** region for the location.

Create a new resource group called *lva-rg*  in the **East US** region for the Media Services and storage accounts. When you finish the tutorials it's easy to remove all the resources by deleting the *lva-rg* resource group.

> [!TIP]
> These tutorials use the **East US** region in all the examples. You can use your closest region if you prefer.

When the deployment is complete, navigate to the **Properties** page for your **Media Services** account. Make a note of the **Resource Id**, you use this value later when you configure the IoT Edge module.

Next, configure an Azure Active Directory service principal for your Media Services resource. Select **API access** and then **Service principal authentication**. Create a new AAD app with the same name as your Media Services resource, and create a secret with a description *IoT Edge Access*.

:::image type="content" source="./media/tutorial-public-safety-create-app/ams-aad.png" alt-text="Configure AAD app for AMS":::

When the secret is generated, scroll down to the section **Copy your credentials to connect your service principal application**. Then select **JSON**. You can copy all the credential information from here in one go. Make a note of this information somewhere safe, you use it later when you configure the IoT Edge device.

> [!WARNING]
> This is your only chance to view and save the secret. If you lose it, you have to generate another secret.

## Clone the LvaGateway repository

The [Lva-gateway](https://hyperlink_to_the_public_facing_repo) GitHub repository contains the sample IoT Edge deployment manifest for the LVA gateway device and the device capability models for the camera devices.

> [!NOTE]
> The repository also includes the source code for the **LvaEdgeGatewayModule** and **lvaYolov3** IoT Edge modules. For more information about working with the source code, see the [Build the Lva Gateway Modules](tutorial-public-safety-build-module.md).

Use the following command to clone the repository to a suitable location on your local machine:

<!-- TODO - be sure to update the address of this repository -->

```cmd
git clone https://github.com/SOMEWHERE/lva-gateway
```

## Create the configuration files

You need to edit the IoT Edge deployment manifest file called *deployment.amd64.json*. Copy this file to the *storage* folder before you make any changes:

1. Create a folder called *storage* in the local copy of the **lva-gateway** repository. This folder is ignored by Git so as to prevent you accidentally checking in any confidential information.

1. Copy the file *deployment.amd64.json* from the *setup* folder to the *storage* folder.

### Edit the deployment manifest

You deploy an IoT Edge module using a deployment manifest. In IoT Central you can import the manifest as a device template, and then let IoT Central manage the module deployment.

To prepare the deployment manifest:

1. Open the *deployment.amd64.json* file in the *storage* folder using a text editor.

    <!-- TODO: Validate this: - By the time this template is ready, the modules will be hosted in a GitHub repo ready to be deployed and the credentials to connect to the registry are already plugged in the deployment document as defaults -->

1. Locate the `\$edgeAgent` object.

1. Modify the registry credentials only if you are building custom modules.

    <!-- If you're just deploying the prebuilt modules - is this step necessary. If not, remove it. -->

    ```json
    {
        "properties.desired": {
          "schemaVersion": "1.0",
          "runtime": {
               "type": "docker",
               "settings": {
                    "minDockerVersion": "v1.25",
                    "loggingOptions": "",
                    "registryCredentials": {
                         "meshams": {
                              "address": "[UserName].azurecr.io",
                              "password": "****",
                              "username": "[UserName]"

                         }
                    }
               }
          }
        }
    }
    ```

    <!-- If you're just deploying the prebuilt modules - is the next step necessary? If not, remove it. -->

1. For each of the modules listed under `modules` update the image element with the desired version:

    |LvaEdgeGatewayModule|   meshams.azurecr.io/scotts/lva-edge-gateway:2.0.42-amd64|
    |lvaYolov3|              mcr.microsoft.com/lva-utilities/yolov3-onnx:1.0|
    |lvaEdge|                mcr.microsoft.com/media/live-video-analytics:1|

1. Add the name of your Media Services account in the `env` node:

    ```json
    "env": {
         "lvaEdgeModuleId": {
              "value": "lvaEdge"
         },
         "amsAccountName": {
              "value": "<YOUR_AZURE_MEDIA_ACCOUNT_NAME>"
         }
    }
    ```

1. Locate the `lvaEdge` module.

1. The template doesn't expose these properties in IoT Central, therefore you need to add the Media Services configuration values to the deployment manifest. Replace the placeholders with the values you made a note of when you created your Media Services account. The `azureMediaServicesArmId` value is the **Resource Id** from the Media Services properties page. You made a note of the `aadTenantId`, `aadServicePrincipalAppId`, and `aadServicePrincipalSecret` when you set up the service principal for your Media Services account:

    ```json
    {
        "lvaEdge":{
        "properties.desired": {
            "applicationDataDirectory": "/var/lib/azuremediaservices",
            "azureMediaServicesArmId": "/subscriptions/[SUBSCRIPTION_ID]/resourceGroups/[RESOURCE]/providers/microsoft.media/mediaservices/[SERVICE]",
            "aadTenantId": "[Tenant ID]",
            "aadServicePrincipalAppId": "[Service Principal]",
            "aadServicePrincipalSecret": "[SECRET]",
            "aadEndpoint": "https://login.microsoftonline.com",
            "aadResourceId": "https://management.core.windows.net/",
            "armEndpoint": "https://management.azure.com/",
            "diagnosticsEventsOutputName": "AmsDiagnostics",
            "operationalMetricsOutputName": "AmsOperational"
            }
        }
    }
    ```

1. Save the changes.

## Create the gateway device

The **Public Safety** application includes an **Lva Edge Motion Detector** device template and an **Lva Edge Motion Detector** device template. In this section you create a gateway device template using the deployment manifest, and add devices to your IoT Central application.

### Create a device template for the Lva Edge Gateway

To import the deployment manifest and create the **Lva Edge Gateway** device template:

1. In your IoT Central application, navigate to **Device Templates**, and select **+ New**.

1. On the **Select template type** page, select the **Azure IoT Edge** tile. Then select **Next: Customize**.

1. On the **Upload an Azure IoT Edge deployment manifest** page, enter *Lva Edge Gateway* as the template name, and check **Gateway device with downstream devices**.

    Do not browse for the deployment manifest yet. If you do, the deployment wizard expects an interface for each module, but you only need to expose the interface for the **LvaEdgeGatewayModule**. You upload the manifest in a later step.

    :::image type="content" source="./media/tutorial-public-safety-create-app/upload-deployment-manifest.png" alt-text="Do not upload deployment manifest":::

    Select **Next: Review**.

1. On the **Review** page, select **Create**.

### Import the device capability model

The device template must include a device capability model. On the **Lva Edge Gateway** page, select the **Import capability model** tile. Navigate to the *setup* folder in your local copy of the **lva-gateway** repository and select the *LvaEdgeGatewayDcm.json* file.

The **Lva Edge Gateway** device template now includes the **LVA Edge Gateway Module** along with three interfaces: **Device information**, **Lva Edge Gateway Settings**, and **Lva Edge Gateway Interface**.

### Replace the manifest

On the **Lva Edge Gateway** page, select **+ Replace manifest**.

:::image type="content" source="./media/tutorial-public-safety-create-app/replace-manifest.png" alt-text="Replace Manifest":::

Navigate to the *storage* folder in your local copy of the **lva-gateway** repository and select the *deployment.amd64.json* manifest file you edited previously. Select **Upload**. When the validation is complete, select **Replace**.

### Add relationships

In the **Lva Edge Gateway** device template, under the **Lva Edge Gateway Module**, select **Relationships**. Select **+ Add relationships** and add the following two relationships:

|Display Name               |Name          |Target |
|-------------------------- |------------- |------ |
|Lva Edge Object Detector   |Use default   |Lva Object Detector Device |
|Lva Edge Motion Detector   |Use default   |Lva Edge Motion Detector Device |

Then select **Save**.

### Add views

<!-- TODO - "this section may need few screen capture - Kishor" -->

The **Lva Edge Gateway** device template doesn't include any view definitions.

To add a view to the device template:

1. In the **Lva Edge Gateway** device template, navigate to **Views** and select the **Visualizing the device** tile.

1. Enter *Lva Edge Gateway device* as the view name.

    <!--TODO - specify what information to add to the view -->
1. Add the Device Information properties to the view.

1. Select **Save**.

### Publish the device template

Before you can add a device to the application, you must publish the device template:

1. In the **Lva Edge Gateway** device template, select **Publish**.

1. On the ***Publish this device template to the application** page, select **Publish**.

**Lva Edge Gateway** is now available as device type to use on the **Devices** page in the application.

## Add a gateway device

To add an **Lva Edge Gateway** device to the application:

1. Navigate to the **Devices** page and select the **Lva Edge Gateway** device template.

1. Select **+ New**.

1. In the **Create a new device** dialog, change the device name to *LVA Gateway 001* and change the device ID to *lva-gateway-001*.

    > [!NOTE]
    > The device ID must be unique in the application.

1. Select **Create**.

The device status is now **Registered**.

### Get the device credentials

You need the credentials that allow the device to connect to your IoT Central application. The get the device credentials:

1. On the **Devices** page, select the **lva-gateway-001** device you created.

1. Select **Connect**.

1. On the **Device connection** page, make a note of the **ID Scope**, the **Device ID**, and the device **Primary Key**. You use these values later.

1. Make sure the connection method is set to **Shared access signature**.

1. Select **Close**.

## Next steps

You've now created an IoT Central application using the **Public Safety** application template, created a device template for the gateway device, and added a gateway device to the application.

If you want to try out the public safety application template using IoT Edge modules running a cloud VM with simulated video streams:

> [!div class="nextstepaction"]
> [Create an IoT Edge instance for live video analytics (Linux VM)](./tutorial-public-safety-edge-vm.md)

If you want to try out the public safety application template using IoT Edge modules running a real device with real **ONVIF** camera:

> [!div class="nextstepaction"]
> [Create an IoT Edge instance for live video analytics (Intel NUC)](./tutorial-public-safety-nuc.md)
