const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const core = require("@actions/core");
const github = require("@actions/github");
const glob = require("glob-promise");
const fetch = require("node-fetch");

async function getAllFilesInDirectory(directory) {
  return new Promise(async (resolve, reject) => {
    try {
      directory = (await getAllFilesMatchingPattern(directory))[0];
      fs.readdir(directory, (err, files) => {
        if (err) {
          reject(err);
          return;
        }
        const filePaths = files.map((file) => path.join(directory, file));
        resolve(filePaths);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function getAllFilesMatchingPattern(pattern) {
  try {
    const filePaths = await glob(pattern);
    return filePaths;
  } catch (err) {
    throw err;
  }
}

async function runAction() {
  // Process inputs
  const allureServerUrl = new URL(
    core.getInput("allure-server-url", { required: true })
  );
  const allureResultsDirectory = core.getInput("allure-results-directory", {
    required: true,
  });
  const projectId = core.getInput("project-id", { required: true });
  const isSecure = core.getInput("is-secure", { required: true });
  const securityUser = core.getInput("security-user", { required: false });
  const securityPass = core.getInput("security-pass", { required: false });
  const allureGenerate = core.getInput("allure-generate", { required: true });
  const cleanResults = core.getInput("allure-clean-results", {
    required: true,
  });

  // Get all the files
  const files = await getAllFilesInDirectory(allureResultsDirectory);
  if (files.length === 0) {
    console.log("No files found in directory. Exiting.");
    return;
  }

  // Login if needed
  let csrfAccessToken;
  let cookies = [];
  if (isSecure === "true") {
    if (!securityUser) {
      throw Error("No auth username provided");
    }
    if (!securityPass) {
      throw Error("No auth password provided");
    }
    console.log("Logging in...");
    const loginResponse = await fetch(
      `${allureServerUrl}allure-docker-service/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: securityUser,
          password: securityPass,
        }),
      }
    );
    if (loginResponse.ok) {
      console.log("Done logging in...");
      const loginCookies = loginResponse.headers.raw()["set-cookie"];
      const csrfAccessTokenPattern = /csrf_access_token=([^;]+)/;
      for (const cookie of loginCookies) {
        const match = cookie.match(csrfAccessTokenPattern);
        if (match && match[1]) {
          csrfAccessToken = match[1];
          break;
        }
      }
      cookies = loginCookies.join("; ");
    } else {
      throw Error(
        `Status code of login was: ${
          loginResponse.statusCode
        } Body: ${await loginResponse.text()}`
      );
    }
  } else if (isSecure === "false") {
    console.log("is-secure set to false, skipping login...");
  } else {
    throw Error("is-secure has to be true/false");
  }

  // Fetch latest report ID
  console.log("Getting report link...");
  const latestReportResponse = await fetch(
    `${allureServerUrl}allure-docker-service/projects/${projectId}`,
    { method: "GET", headers: { Cookie: cookies } }
  );
  const latestReportBody = await latestReportResponse.json();
  if (latestReportResponse.ok) {
    console.log("Done getting report link...");
    const latestReportId = latestReportBody.data.project.reports_id[1];
    const reportLink = `${allureServerUrl}allure-docker-service-ui/projects/${projectId}/reports/${
      parseInt(latestReportId) + 1
    }`;
    console.log("Allure Report Link:", reportLink);
  } else {
    throw Error(
      `Failed to fetch latest report ID. Status code: ${latestReportResponse.statusCode} Body: ${latestReportBody}`
    );
  }

  // Clean results
  if (cleanResults === "true") {
    console.log("Cleaning results...");
    const cleanResultsResponse = await fetch(
      `${allureServerUrl}allure-docker-service/clean-results?project_id=${projectId}`,
      { method: "GET", headers: { Cookie: cookies } }
    );
    if (cleanResultsResponse.ok) {
      console.log("Done cleaning results...");
    } else {
      throw Error(
        `Failed to clean results. Status code: ${
          cleanResultsResponse.statusCode
        } Body: ${await cleanResultsResponse.text()}`
      );
    }
  } else if (cleanResults === "false") {
    console.log("Not cleaning results...");
  } else {
    throw Error("allure-clean-results has to be true/false");
  }

  // Send results
  console.log("Sending results...");
  const formData = new FormData();
  files.forEach((filePath) => {
    formData.append("files[]", fs.createReadStream(filePath));
  });
  const sendResultsResponse = await fetch(
    `${allureServerUrl}allure-docker-service/send-results?project_id=${projectId}`,
    {
      method: "POST",
      body: formData,
      headers: {
        "X-CSRF-TOKEN": csrfAccessToken,
        ...formData.getHeaders(),
        Cookie: cookies,
      },
    }
  );
  if (sendResultsResponse.ok) {
    console.log("Done sending results...");
  } else {
    throw Error(
      `Failed to send results. Status code: ${
        sendResultsResponse.statusCode
      } Body: ${await sendResultsResponse.text()}`
    );
  }

  // Check if allure-generate is true
  if (allureGenerate === "true") {
    console.log("Generating report...");
    const executionName = "GitHub+Actions";
    const executionFrom = `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`;
    const executionFromEncoded = encodeURIComponent(executionFrom);
    const generateUrl = `${allureServerUrl}allure-docker-service/generate-report?project_id=${projectId}&execution_name=${executionName}&execution_from=${executionFromEncoded}`;
    const response = await fetch(generateUrl, {
      method: "GET",
      headers: { "X-CSRF-TOKEN": csrfAccessToken, Cookie: cookies },
    });
    const responseBody = await response.json();
    if (response.ok) {
      console.log("Done generating report...");
      const reportLink = responseBody.data.report_url;
      console.log("Allure Report Link:", reportLink);
    } else {
      throw Error(
        `Failed to generate report. Status code: ${response.statusCode} Body: ${responseBody}`
      );
    }
  } else if (allureGenerate === "false") {
    console.log("Not generating report...");
  } else {
    throw Error("allure-generate has to be true/false");
  }
}

runAction().catch((err) => {
  core.error(err.message);
  core.setFailed(err.message);
});
