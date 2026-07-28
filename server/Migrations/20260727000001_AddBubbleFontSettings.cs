using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebOcrServer.Migrations
{
    /// <inheritdoc />
    public partial class AddBubbleFontSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "FontFamily",
                table: "PageTranslationLogs",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "FontSizeOverride",
                table: "PageTranslationLogs",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FontFamily",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "FontSizeOverride",
                table: "PageTranslationLogs");
        }
    }
}
