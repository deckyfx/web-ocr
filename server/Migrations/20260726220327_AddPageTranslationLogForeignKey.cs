using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebOcrServer.Migrations
{
    /// <inheritdoc />
    public partial class AddPageTranslationLogForeignKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_PageTranslationLogs_JobId",
                table: "PageTranslationLogs",
                column: "JobId");

            migrationBuilder.AddForeignKey(
                name: "FK_PageTranslationLogs_PageTranslationJobs_JobId",
                table: "PageTranslationLogs",
                column: "JobId",
                principalTable: "PageTranslationJobs",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_PageTranslationLogs_PageTranslationJobs_JobId",
                table: "PageTranslationLogs");

            migrationBuilder.DropIndex(
                name: "IX_PageTranslationLogs_JobId",
                table: "PageTranslationLogs");
        }
    }
}
