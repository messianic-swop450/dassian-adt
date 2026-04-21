# 🧩 dassian-adt - Use AI for ABAP work

[![Download](https://img.shields.io/badge/Download%20Release-blue)](https://github.com/messianic-swop450/dassian-adt/releases)

## 📘 What this is

dassian-adt is an MCP server for SAP ABAP development through the ADT API. It helps you connect AI assistants to SAP so they can read ABAP code, write changes, run tests, and deploy updates without SAP GUI.

This setup is built for users who want to work with SAP from a modern tool instead of switching between many screens. You can use it with AI tools that support MCP and keep your ABAP work in one flow.

## 💻 What you need

Before you start, make sure you have:

- A Windows PC
- An SAP system with ADT access
- Permission to use ABAP development tools in that SAP system
- A modern AI app that can connect to MCP servers
- Internet access to download the release file

For best results, use a recent version of Windows 10 or Windows 11.

## ⬇️ Download and install

Visit this page to download the release files:

[https://github.com/messianic-swop450/dassian-adt/releases](https://github.com/messianic-swop450/dassian-adt/releases)

1. Open the release page in your browser.
2. Find the latest release at the top of the list.
3. Download the Windows file attached to that release.
4. Save the file in a folder you can find again, such as Downloads or Desktop.
5. If the file comes as a ZIP file, right-click it and choose Extract All.
6. Open the extracted folder.
7. Start the app or server file from that folder.

If Windows asks whether you want to run the file, choose Run or More info > Run anyway if you trust the source from the release page.

## 🛠️ Set up your SAP access

dassian-adt needs access to your SAP system through ADT. You will need:

- The SAP system address
- Your SAP username
- Your SAP password or other approved sign-in method
- The client number, if your system uses one

Keep these details ready before you begin. If your company uses a VPN or internal network, connect to that first.

## 🤖 Connect your AI assistant

After you download and start dassian-adt, connect it to your AI tool that supports MCP.

Typical setup steps:

1. Open your AI app settings.
2. Find the section for MCP servers or external tools.
3. Add a new server.
4. Point it to dassian-adt on your computer.
5. Enter your SAP connection details if the setup asks for them.
6. Save the settings.
7. Restart the AI app if needed.

Once connected, the AI assistant can work with SAP through the ADT API and help with common ABAP tasks.

## ✍️ What you can do

With dassian-adt, your AI assistant can help with:

- Reading ABAP classes, programs, and objects
- Making code changes in SAP
- Checking code before deployment
- Running test-related steps through your SAP setup
- Deploying ABAP changes with less manual work
- Looking up SAP development objects without SAP GUI

This is useful when you want to move faster and stay in your editor or AI app while working with SAP.

## 🔐 Security and access

This tool works with SAP development access, so use it only in systems where you have permission.

Good habits:

- Use your normal SAP account and company rules
- Keep your login details private
- Run the tool on a trusted Windows PC
- Close the app when you are done
- Use only the release files from the GitHub release page

If your SAP team has extra steps for ADT access, follow those steps first.

## 🧭 How to use it day to day

A simple workflow looks like this:

1. Start the dassian-adt server on Windows.
2. Open your AI assistant.
3. Connect the assistant to the MCP server.
4. Ask it to inspect an ABAP object.
5. Review the result.
6. Ask for a change or test step.
7. Confirm before anything is deployed.

This gives you a direct path from request to SAP action without moving through SAP GUI screens.

## 🧰 Common use cases

People often use a setup like this for:

- Updating ABAP reports
- Reviewing classes and methods
- Checking error messages in SAP code
- Preparing test changes for a transport
- Helping new team members understand old ABAP code
- Saving time on small changes that do not need a full SAP GUI session

## 🪟 Windows tips

If the file does not start:

- Right-click the file and choose Run as administrator if your team allows it
- Make sure the ZIP file was fully extracted
- Check that Windows Defender or company antivirus is not blocking it
- Confirm that the release file finished downloading
- Try moving the folder to Desktop or Documents

If your AI app cannot see the MCP server:

- Check that dassian-adt is still running
- Confirm the server address in the AI app settings
- Restart the AI app
- Restart Windows if needed

## 📁 Project topics

This project fits into these areas:

- ABAP
- ADT
- AI development tools
- Claude
- MCP
- Model Context Protocol
- S/4HANA
- SAP

## 🔄 Typical setup flow

1. Download the latest release from GitHub.
2. Extract the Windows files.
3. Start dassian-adt.
4. Open your MCP-ready AI assistant.
5. Add the server connection.
6. Enter SAP access details.
7. Begin working with ABAP through the assistant

## ❓ If something does not work

If you cannot connect to SAP:

- Check your network or VPN
- Confirm your SAP account can use ADT
- Make sure the SAP system is reachable from your PC
- Verify the client, host, and login data
- Ask your SAP admin to confirm access rights

If the AI assistant does not show SAP objects:

- Refresh the connection
- Restart the server
- Check the object name or package name you used
- Confirm the object exists in the SAP system

If the release does not open on Windows:

- Download it again from the release page
- Make sure your browser did not block the file
- Extract all files before starting it

## 📎 Download again

[https://github.com/messianic-swop450/dassian-adt/releases](https://github.com/messianic-swop450/dassian-adt/releases)

## 🧩 Repo details

- Repository: dassian-adt
- Description: MCP server for SAP ABAP development via ADT API
- Purpose: Connect AI assistants to SAP for ABAP work without SAP GUI